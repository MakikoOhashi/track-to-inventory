/**
 * Stage L4.3a — one-shot managed re-store of the existing offline session.
 *
 *   npx tsx --env-file=.env.local scripts/session-l43a-managed-restore.mts --dry-run
 *   npx tsx --env-file=.env.local scripts/session-l43a-managed-restore.mts --apply
 *
 * Uses UpstashSessionStorage.storeSession once (Redis primary + dual-write mirror).
 * Aborts if the session is online / has Redis TTL (would change expiry semantics).
 * Not imported by the Worker. Do not leave --apply running unattended.
 *
 * L4.3b finding: getPlatformProxy({ remoteBindings: true }) alone does NOT make
 * TTI_DB remote. wrangler requires d1_databases[].remote === true; otherwise the
 * proxy is a local empty D1 (no shopify_sessions) and dual-write logs write_error.
 * Do not re-apply until a Worker-path or correctly remote-bound path is approved.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const APPLY = process.argv.includes("--apply");
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_HASH = "34c1ff3514f08d08";
const TARGET_SHOP = "luckywifi-0.myshopify.com";

type StoredSessionPayload = {
  entries: [string, string | number | boolean][];
  shop: string;
  expiresAt?: number;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function d1Execute(sql: string): Array<Record<string, unknown>> {
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
      `d1 failed: ${(result.stderr || result.stdout || "")
        .slice(0, 200)
        .replace(/shpat_[^\s'"]+/g, "<redacted>")}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Array<{
    results?: Array<Record<string, unknown>>;
  }>;
  return parsed[0]?.results ?? [];
}

function fingerprint(session: Session): string {
  const entries = session
    .toPropertyArray(true)
    .map(([k, v]) => [String(k), v] as [string, string | number | boolean])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")
    .slice(0, 16);
}

function assertSafe(obj: unknown) {
  const s = JSON.stringify(obj);
  if (/shpat_|state-secret|eyJhbGci/i.test(s)) {
    throw new Error("secret leakage in output");
  }
}

async function main() {
  process.env.SESSION_D1_MODE = "dual_write";

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

  const legacyKeys = (
    (await redis.scan(0, { match: "shopify:session:*", count: 50 })) as [
      string | number,
      string[],
    ]
  )[1]
    .filter((k) => !k.startsWith("tti:"));

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

  if (idHash !== TARGET_HASH || session.shop !== TARGET_SHOP) {
    throw new Error("target session mismatch (hash/shop)");
  }
  if (session.isOnline || session.expires || payload.expiresAt) {
    throw new Error(
      "abort: online/expiring session — storeSession would use SETEX and change TTL",
    );
  }
  if (ttl !== -1) {
    throw new Error(`abort: redis TTL is ${ttl}, expected -1 (no expiry change)`);
  }

  const d1Live = d1Execute(
    `SELECT COUNT(*) AS c FROM shopify_sessions
     WHERE IFNULL(migration_source, '') != ${sqlString(SESSION_MIGRATION_SOURCE_DELETED)}`,
  );
  const d1Dup = d1Execute(
    `SELECT COUNT(*) AS c FROM (
       SELECT id FROM shopify_sessions GROUP BY id HAVING COUNT(*) > 1
     )`,
  );
  const d1Row = d1Execute(
    `SELECT payload_json, is_online, expires_at, migration_source, updated_at
     FROM shopify_sessions WHERE shop = ${sqlString(TARGET_SHOP)}
       AND IFNULL(migration_source, '') != ${sqlString(SESSION_MIGRATION_SOURCE_DELETED)}`,
  );
  if (d1Row.length !== 1) {
    throw new Error(`expected 1 live D1 row, got ${d1Row.length}`);
  }
  const d1Payload = JSON.parse(String(d1Row[0].payload_json));
  const d1Session = Session.fromPropertyArray(d1Payload.entries, true);
  const d1Fp = fingerprint(d1Session);
  const ledger = d1Execute(
    `SELECT COUNT(*) AS c,
            SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS s
     FROM inventory_sync_ledger`,
  )[0];

  const before = {
    type: "session_l43a_managed_restore_before",
    mode: APPLY ? "apply" : "dry-run",
    redis_tti: ttiKeys.length,
    redis_legacy: legacyKeys.length,
    redis_ttl: ttl,
    session_id_hash: idHash,
    shop: session.shop,
    is_online: session.isOnline,
    has_expires: Boolean(session.expires),
    fingerprint: fp,
    d1_live: Number(d1Live[0]?.c ?? -1),
    d1_dup: Number(d1Dup[0]?.c ?? -1),
    d1_fingerprint: d1Fp,
    d1_is_online: Number(d1Row[0].is_online),
    d1_expires_at: d1Row[0].expires_at ?? null,
    fingerprint_match: fp === d1Fp,
    ledger_succeeded: Number(ledger?.s ?? -1),
    expiry_safe: true,
  };
  assertSafe(before);
  console.log(JSON.stringify(before));

  if (!APPLY) {
    console.log(
      JSON.stringify({
        type: "session_l43a_managed_restore_dry_run",
        next: "re-run with --apply once",
      }),
    );
    return;
  }

  if (fp !== d1Fp) {
    throw new Error("abort apply: Redis/D1 fingerprint mismatch before write");
  }

  const proxy = await getPlatformProxy({
    persist: false,
    // Connect to production D1 for the dual-write mirror leg.
    // @ts-expect-error wrangler remoteBindings option
    remoteBindings: true,
  });

  let writeOk = false;
  try {
    const db = (proxy.env as { TTI_DB?: D1Database }).TTI_DB;
    if (!db) throw new Error("TTI_DB remote binding missing");

    const redisOk = await runWithCloudflareEnv(
      {
        env: { ...proxy.env, SESSION_D1_MODE: "dual_write" } as Env,
        ctx: {
          waitUntil() {},
          passThroughOnException() {},
        } as ExecutionContext,
      },
      async () => sessionStorage.storeSession(session),
    );
    writeOk = redisOk === true;
  } finally {
    await proxy.dispose();
  }

  const ttlAfter = await redis.ttl(key);
  const payloadAfter = (await redis.get(key)) as StoredSessionPayload | null;
  const sessionAfter = Session.fromPropertyArray(payloadAfter!.entries, true);
  const fpAfter = fingerprint(sessionAfter);
  const d1After = d1Execute(
    `SELECT payload_json, is_online, expires_at, migration_source
     FROM shopify_sessions WHERE shop = ${sqlString(TARGET_SHOP)}
       AND IFNULL(migration_source, '') != ${sqlString(SESSION_MIGRATION_SOURCE_DELETED)}`,
  );
  const d1SessionAfter = Session.fromPropertyArray(
    JSON.parse(String(d1After[0].payload_json)).entries,
    true,
  );
  const d1FpAfter = fingerprint(d1SessionAfter);
  const d1LiveAfter = Number(
    d1Execute(
      `SELECT COUNT(*) AS c FROM shopify_sessions
       WHERE IFNULL(migration_source, '') != ${sqlString(SESSION_MIGRATION_SOURCE_DELETED)}`,
    )[0]?.c ?? -1,
  );
  const ledgerAfter = d1Execute(
    `SELECT SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS s
     FROM inventory_sync_ledger`,
  )[0];

  const after = {
    type: "session_l43a_managed_restore_after",
    redis_store_ok: writeOk,
    redis_ttl_after: ttlAfter,
    redis_ttl_unchanged: ttlAfter === -1,
    fingerprint_after: fpAfter,
    fingerprint_unchanged: fpAfter === fp,
    d1_fingerprint_after: d1FpAfter,
    fingerprint_match_after: fpAfter === d1FpAfter,
    d1_live_after: d1LiveAfter,
    d1_is_online_after: Number(d1After[0].is_online),
    d1_expires_at_after: d1After[0].expires_at ?? null,
    ledger_succeeded_after: Number(ledgerAfter?.s ?? -1),
  };
  assertSafe(after);
  console.log(JSON.stringify(after));

  if (
    !writeOk ||
    !after.redis_ttl_unchanged ||
    !after.fingerprint_unchanged ||
    !after.fingerprint_match_after ||
    after.d1_live_after !== 1
  ) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
