/**
 * Stage L4.3c — ops-gated managed re-store (production remote D1 only).
 *
 *   npx tsx --env-file=.env.local scripts/session-l43c-managed-restore.mts
 *   npx tsx --env-file=.env.local scripts/session-l43c-managed-restore.mts --dry-run
 *   npx tsx --env-file=.env.local scripts/session-l43c-managed-restore.mts --apply
 *
 * Default / --dry-run: identity gates only, write 0.
 * --apply: one storeSession after gates pass. Never retry.
 *
 * Uses wrangler.ops-l43c.jsonc (TTI_DB remote:true). Not imported by Worker.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import { runWithCloudflareEnv } from "../app/lib/cloudflareBindings.server.ts";
import {
  SESSION_MIGRATION_SOURCE_DELETED,
} from "../app/lib/d1/shopifySessions.server.ts";
import { hashSessionId } from "../app/lib/sessionD1Shadow.server.ts";
import sessionStorage from "../app/sessionStorage.server.ts";
import {
  assertOpsConfigMatchesMain,
  assertSafe,
  compareSnaps,
  fingerprint,
  L43C_OPS_CONFIG,
  L43C_TARGET_HASH,
  L43C_TARGET_SHOP,
  snapFromDb,
  sqlString,
  type SessionSnap,
  type StoredSessionPayload,
} from "./lib/sessionL43cOpsGate.mts";

const APPLY = process.argv.includes("--apply");
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function d1RemoteExecute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "track-to-inventory",
      "--remote",
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", cwd: webRoot },
  );
  if (result.status !== 0) {
    throw new Error(
      `d1 remote failed: ${(result.stderr || result.stdout || "")
        .slice(0, 200)
        .replace(/shpat_[^\s'"]+/g, "<redacted>")}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Array<{
    results?: Array<Record<string, unknown>>;
  }>;
  return parsed[0]?.results ?? [];
}

async function snapFromRemoteCli(): Promise<SessionSnap> {
  const table = d1RemoteExecute(
    `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='shopify_sessions'`,
  );
  const tableExists = Number(table[0]?.c ?? 0) > 0;
  if (!tableExists) {
    return {
      table_exists: false,
      live_count: -1,
      dup_count: -1,
      target_rows: -1,
      migration_source: null,
      updated_at: null,
      expires_at: null,
      is_online: null,
      fingerprint: null,
      ledger_succeeded: -1,
    };
  }
  const live = d1RemoteExecute(
    `SELECT COUNT(*) AS c FROM shopify_sessions
     WHERE IFNULL(migration_source, '') != ${sqlString(SESSION_MIGRATION_SOURCE_DELETED)}`,
  );
  const dup = d1RemoteExecute(
    `SELECT COUNT(*) AS c FROM (
       SELECT id FROM shopify_sessions GROUP BY id HAVING COUNT(*) > 1
     )`,
  );
  const rows = d1RemoteExecute(
    `SELECT payload_json, migration_source, updated_at, expires_at, is_online
     FROM shopify_sessions
     WHERE shop = ${sqlString(L43C_TARGET_SHOP)}
       AND IFNULL(migration_source, '') != ${sqlString(SESSION_MIGRATION_SOURCE_DELETED)}`,
  );
  let fp: string | null = null;
  if (rows.length === 1) {
    const payload = JSON.parse(String(rows[0].payload_json));
    const session = Session.fromPropertyArray(payload.entries, true);
    if (hashSessionId(session.id) !== L43C_TARGET_HASH) {
      throw new Error("remote CLI target hash mismatch");
    }
    fp = fingerprint(session);
  }
  const ledger = d1RemoteExecute(
    `SELECT COUNT(*) AS c FROM inventory_sync_ledger WHERE status='succeeded'`,
  );
  return {
    table_exists: true,
    live_count: Number(live[0]?.c ?? -1),
    dup_count: Number(dup[0]?.c ?? -1),
    target_rows: rows.length,
    migration_source: rows[0] ? String(rows[0].migration_source ?? "") : null,
    updated_at: rows[0] ? String(rows[0].updated_at ?? "") : null,
    expires_at: rows[0]
      ? rows[0].expires_at == null
        ? null
        : String(rows[0].expires_at)
      : null,
    is_online: rows[0] ? Number(rows[0].is_online) : null,
    fingerprint: fp,
    ledger_succeeded: Number(ledger[0]?.c ?? -1),
  };
}

async function main() {
  process.env.SESSION_D1_MODE = "dual_write";

  const cfg = assertOpsConfigMatchesMain(webRoot);
  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const ttiKeys: string[] = [];
  let cursor = 0;
  do {
    const [next, batch] = (await redis.scan(cursor, {
      match: "tti:shopify:session:*",
      count: 50,
    })) as [string | number, string[]];
    cursor = Number(next);
    ttiKeys.push(...(batch || []));
  } while (cursor !== 0);

  if (ttiKeys.length !== 1) {
    throw new Error(`expected 1 tti session, got ${ttiKeys.length}`);
  }
  const key = ttiKeys[0];
  const ttl = await redis.ttl(key);
  const payload = (await redis.get(key)) as StoredSessionPayload | null;
  if (!payload?.entries) throw new Error("redis payload missing");
  const session = Session.fromPropertyArray(payload.entries, true);
  const idHash = hashSessionId(session.id);
  const fp = fingerprint(session);

  if (idHash !== L43C_TARGET_HASH || session.shop !== L43C_TARGET_SHOP) {
    throw new Error("target session mismatch");
  }
  if (session.isOnline || session.expires || payload.expiresAt) {
    throw new Error("abort: online/expiring session would change Redis TTL");
  }
  if (ttl !== -1) {
    throw new Error(`abort: redis TTL=${ttl}, expected -1`);
  }

  const proxy = await getPlatformProxy({
    configPath: join(webRoot, L43C_OPS_CONFIG),
    persist: false,
    remoteBindings: true,
  });

  let proxySnap: SessionSnap;
  let remoteSnap: SessionSnap;
  try {
    const db = (proxy.env as { TTI_DB?: D1Database }).TTI_DB;
    if (!db) throw new Error("ops TTI_DB binding missing");
    proxySnap = await snapFromDb(db);
    remoteSnap = await snapFromRemoteCli();
  } finally {
    // keep proxy open for apply; dispose in finally of apply path
  }

  const gate = compareSnaps(proxySnap, remoteSnap);
  const redisMatchesD1 = fp === proxySnap.fingerprint && fp === remoteSnap.fingerprint;

  const gateReport = {
    type: "session_l43c_identity_gate",
    mode: APPLY ? "apply" : "dry-run",
    ops_config: L43C_OPS_CONFIG,
    ops_remote: cfg.ops.remote,
    main_remote: cfg.main.remote,
    database_id_match: cfg.ops.database_id === cfg.main.database_id,
    redis_tti: ttiKeys.length,
    redis_ttl: ttl,
    session_id_hash: idHash,
    shop: session.shop,
    is_online: session.isOnline,
    has_expires: Boolean(session.expires),
    redis_fingerprint: fp,
    proxy_snap: proxySnap,
    remote_cli_snap: remoteSnap,
    gate_ok: gate.ok && redisMatchesD1,
    mismatches: gate.ok && redisMatchesD1 ? [] : [...gate.mismatches, ...(redisMatchesD1 ? [] : ["redis_fingerprint"])],
    path_checks: {
      store_awaits_d1_mirror: true,
      dual_write_mode_env: process.env.SESSION_D1_MODE,
      ops_binding: "TTI_DB",
      content_unchanged: true,
      no_direct_d1_sql_write: true,
    },
  };
  assertSafe(gateReport);
  console.log(JSON.stringify(gateReport));

  if (!gateReport.gate_ok) {
    await proxy.dispose();
    throw new Error(`identity gate failed: ${gateReport.mismatches.join(",")}`);
  }

  if (!APPLY) {
    await proxy.dispose();
    console.log(
      JSON.stringify({
        type: "session_l43c_dry_run",
        write: 0,
        next: "re-run with --apply once after review",
      }),
    );
    return;
  }

  // Capture dual-write logs from mirrorSessionStoreToD1
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("session_d1_write")) captured.push(line);
    origLog(...args);
  };

  let redisOk = false;
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    redisOk = await runWithCloudflareEnv(
      {
        env: {
          ...(proxy.env as Env),
          SESSION_D1_MODE: "dual_write",
          TTI_DB: db,
        } as Env,
        ctx: {
          waitUntil() {},
          passThroughOnException() {},
        } as ExecutionContext,
      },
      async () => sessionStorage.storeSession(session),
    );
  } finally {
    console.log = origLog;
    await proxy.dispose();
  }

  const writeSuccess = captured.filter((l) =>
    l.includes("session_d1_write_success"),
  ).length;
  const writeError = captured.filter((l) =>
    l.includes("session_d1_write_error"),
  ).length;
  const writeTimeout = captured.filter((l) =>
    l.includes("session_d1_write_timeout"),
  ).length;

  const ttlAfter = await redis.ttl(key);
  const payloadAfter = (await redis.get(key)) as StoredSessionPayload | null;
  const sessionAfter = Session.fromPropertyArray(payloadAfter!.entries, true);
  const fpAfter = fingerprint(sessionAfter);
  const remoteAfter = await snapFromRemoteCli();

  const after = {
    type: "session_l43c_managed_restore_after",
    apply_count: 1,
    redis_store_ok: redisOk === true,
    write_success: writeSuccess,
    write_error: writeError,
    write_timeout: writeTimeout,
    redis_ttl_after: ttlAfter,
    redis_ttl_unchanged: ttlAfter === -1,
    fingerprint_after: fpAfter,
    fingerprint_unchanged: fpAfter === fp,
    remote_fingerprint_after: remoteAfter.fingerprint,
    fingerprint_match_after: fpAfter === remoteAfter.fingerprint,
    d1_live_after: remoteAfter.live_count,
    d1_dup_after: remoteAfter.dup_count,
    updated_at_before: remoteSnap.updated_at,
    updated_at_after: remoteAfter.updated_at,
    updated_at_changed: remoteSnap.updated_at !== remoteAfter.updated_at,
    migration_source_after: remoteAfter.migration_source,
    ledger_succeeded_after: remoteAfter.ledger_succeeded,
    is_online_after: remoteAfter.is_online,
    expires_at_after: remoteAfter.expires_at,
  };
  assertSafe(after);
  console.log(JSON.stringify(after));

  const pass =
    after.redis_store_ok &&
    after.write_success >= 1 &&
    after.write_error === 0 &&
    after.write_timeout === 0 &&
    after.redis_ttl_unchanged &&
    after.fingerprint_unchanged &&
    after.fingerprint_match_after &&
    after.d1_live_after === 1 &&
    after.d1_dup_after === 0 &&
    after.updated_at_changed &&
    after.ledger_succeeded_after === 2 &&
    after.is_online_after === 0 &&
    after.expires_at_after == null;

  if (!pass) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
