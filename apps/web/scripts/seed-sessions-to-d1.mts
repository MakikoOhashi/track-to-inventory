/**
 * Stage L4.1 — seed Redis offline session → D1 shopify_sessions.
 *
 *   npx tsx --env-file=.env.local scripts/seed-sessions-to-d1.mts --dry-run --remote
 *   npx tsx --env-file=.env.local scripts/seed-sessions-to-d1.mts --apply --remote
 *   npx tsx --env-file=.env.local scripts/seed-sessions-to-d1.mts --apply --local
 *
 * Redis: GET/SCAN/TTL only. Never findSessionsByShop. No Worker deploy.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import { createShopifySessionRepository } from "../app/lib/d1/shopifySessions.server.ts";
import {
  assertNoSecretsInOutput,
  buildD1RowFromCandidate,
  classifyD1Conflict,
  hashSessionId,
  L41_TARGET_ID_HASH,
  L41_TARGET_SHOP,
  safeMetaFromSession,
  selectL41Candidate,
  sessionFingerprint,
  type D1ExistingSafe,
  type SeedCandidate,
} from "./lib/sessionSeedCore.mts";

const DRY_RUN = process.argv.includes("--dry-run") || !process.argv.includes("--apply");
const APPLY = process.argv.includes("--apply");
const REMOTE = process.argv.includes("--remote");
const targetFlag = REMOTE ? "--remote" : "--local";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sqlString(value: string | null | undefined): string {
  if (value == null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1Execute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "track-to-inventory",
      targetFlag,
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", cwd: webRoot },
  );
  if (result.status !== 0) {
    const err = `${result.stderr || result.stdout || ""}`.slice(0, 300);
    // Never echo SQL (may contain payload)
    throw new Error(`d1 execute failed (${targetFlag}): ${err.replace(/shpat_[^\s'"]+/g, "<redacted>")}`);
  }
  const parsed = JSON.parse(result.stdout) as Array<{
    results?: Array<Record<string, unknown>>;
  }>;
  return parsed[0]?.results ?? [];
}

async function scanKeys(redis: Redis, match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [next, batch] = (await redis.scan(cursor, {
      match,
      count: 200,
    })) as [string | number, string[]];
    cursor = Number(next);
    keys.push(...(batch || []));
  } while (cursor !== 0);
  return [...new Set(keys)];
}

async function readRedisInventory(redis: Redis) {
  const newKeys = await scanKeys(redis, "tti:shopify:session:*");
  const legacyKeys = (await scanKeys(redis, "shopify:session:*")).filter(
    (k) => !k.startsWith("tti:"),
  );
  const newSets = await scanKeys(redis, "tti:shopify:shop-sessions:*");
  const legacySets = (await scanKeys(redis, "shopify:shop-sessions:*")).filter(
    (k) => !k.startsWith("tti:"),
  );

  const newSessions: Array<{ id: string; payload: unknown; ttl: number }> = [];
  for (const key of newKeys) {
    const id = key.slice("tti:shopify:session:".length);
    const payload = await redis.get(key);
    const ttl = await redis.ttl(key);
    newSessions.push({ id, payload, ttl });
  }

  const legacyById = new Map<string, unknown>();
  for (const key of legacyKeys) {
    const id = key.slice("shopify:session:".length);
    legacyById.set(id, await redis.get(key));
  }

  // Fingerprint of Redis inventory (counts + session fps) for before/after
  const fps: string[] = [];
  for (const s of newSessions) {
    if (!s.payload) continue;
    try {
      const p = s.payload as { entries: [string, string | number | boolean][]; shop: string };
      const session = Session.fromPropertyArray(p.entries, true);
      fps.push(sessionFingerprint(session, p.entries.map(([k]) => String(k))));
    } catch {
      fps.push("invalid");
    }
  }
  fps.sort();

  return {
    counts: {
      tti_session_keys: newKeys.length,
      legacy_session_keys: legacyKeys.length,
      tti_shop_sets: newSets.length,
      legacy_shop_sets: legacySets.length,
    },
    ttls: newSessions.map((s) => s.ttl),
    inventory_fingerprint: createHash("sha256")
      .update(JSON.stringify({ counts: { n: newKeys.length, l: legacyKeys.length }, fps }))
      .digest("hex")
      .slice(0, 24),
    newSessions,
    legacyById,
  };
}

function loadExistingFromD1(id: string): D1ExistingSafe | null {
  // Only fetch metadata columns + payload for in-memory restore; never print payload
  const rows = d1Execute(
    `SELECT id, shop, is_online, expires_at, payload_json FROM shopify_sessions WHERE id = ${sqlString(id)} LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  try {
    const payload = JSON.parse(String(row.payload_json));
    const session = Session.fromPropertyArray(payload.entries, true);
    const keys = payload.entries.map(([k]: [string, unknown]) => String(k));
    return {
      id_hash: hashSessionId(String(row.id)),
      shop: String(row.shop),
      is_online: Number(row.is_online) === 1,
      expires_at: row.expires_at == null || row.expires_at === "" ? null : String(row.expires_at),
      fingerprint: sessionFingerprint(session, keys),
    };
  } catch {
    throw new Error("conflict: existing D1 row failed restore");
  }
}

function countD1Sessions(): number {
  const row = d1Execute(`SELECT COUNT(*) AS c FROM shopify_sessions`)[0];
  return Number(row?.c ?? 0);
}

function insertViaWrangler(candidate: SeedCandidate): void {
  const row = buildD1RowFromCandidate(candidate);
  const now = new Date().toISOString();
  // INSERT only — no upsert
  const sql = `INSERT INTO shopify_sessions (
    id, shop, payload_json, is_online, expires_at,
    migration_source, migration_version, created_at, updated_at
  ) VALUES (
    ${sqlString(row.id)},
    ${sqlString(row.shop)},
    ${sqlString(row.payload_json)},
    ${row.is_online},
    ${sqlString(row.expires_at)},
    ${sqlString(row.migration_source)},
    ${sqlString(row.migration_version)},
    ${sqlString(now)},
    ${sqlString(now)}
  )`;
  d1Execute(sql);
}

async function insertViaLocalRepo(candidate: SeedCandidate): Promise<void> {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    const existing = await db
      .prepare(`SELECT id FROM shopify_sessions WHERE id = ?`)
      .bind(candidate.session.id)
      .first();
    if (existing) {
      throw new Error("local insert aborted: row exists (use conflict path)");
    }
    const repo = createShopifySessionRepository(db);
    // repository upserts — for seed we want insert-only semantics already checked
    await repo.storeSession(candidate.session);
    // Fix migration_source to redis/l4.1
    await db
      .prepare(
        `UPDATE shopify_sessions
         SET migration_source = 'redis', migration_version = 'l4.1-v1'
         WHERE id = ?`,
      )
      .bind(candidate.session.id)
      .run();
  } finally {
    await proxy.dispose();
  }
}

function verifyD1AgainstCandidate(candidate: SeedCandidate): Record<string, unknown> {
  const rows = d1Execute(
    `SELECT id, shop, is_online, expires_at, payload_json FROM shopify_sessions WHERE shop = ${sqlString(candidate.shop)}`,
  );
  if (rows.length !== 1) {
    throw new Error(`verify failed: expected 1 row for shop, got ${rows.length}`);
  }
  const row = rows[0];
  const payload = JSON.parse(String(row.payload_json));
  const session = Session.fromPropertyArray(payload.entries, true);
  const keys = payload.entries.map(([k]: [string, unknown]) => String(k));
  const meta = safeMetaFromSession(session, keys);
  const redisMeta = safeMetaFromSession(candidate.session, candidate.entry_keys);

  const dup = d1Execute(
    `SELECT COUNT(*) AS c FROM (
       SELECT id FROM shopify_sessions GROUP BY id HAVING COUNT(*) > 1
     )`,
  )[0];

  return {
    id_hash_match: meta.id_hash === candidate.id_hash,
    shop_match: meta.shop === candidate.shop && meta.shop === L41_TARGET_SHOP,
    is_online: meta.is_online,
    has_expires: meta.has_expires,
    entry_keys: meta.entry_keys,
    fingerprint_match: meta.fingerprint === redisMeta.fingerprint,
    d1_duplicate_ids: Number(dup?.c ?? 0),
    target_hash_ok: meta.id_hash === L41_TARGET_ID_HASH,
  };
}

async function main() {
  if (APPLY && DRY_RUN && process.argv.includes("--dry-run")) {
    // --dry-run wins if both passed incorrectly: prefer explicit dry-run
  }
  const mode = APPLY && !process.argv.includes("--dry-run") ? "apply" : "dry-run";

  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const before = await readRedisInventory(redis);
  const selected = selectL41Candidate({
    newSessions: before.newSessions.map((s) => ({ id: s.id, payload: s.payload })),
    legacyById: before.legacyById,
  });

  if (!selected.ok) {
    const out = {
      type: "session_l41_seed_abort",
      mode,
      target: REMOTE ? "remote" : "local",
      error: selected.error,
      redis_before: before.counts,
    };
    assertNoSecretsInOutput(out);
    console.log(JSON.stringify(out));
    process.exit(1);
  }

  const candidate = selected.candidate;
  const d1Before = countD1Sessions();
  const existing = loadExistingFromD1(candidate.session.id);
  const action = classifyD1Conflict(candidate, existing);

  if (action === "conflict") {
    const out = {
      type: "session_l41_seed_abort",
      mode,
      target: REMOTE ? "remote" : "local",
      error: "conflict",
      id_hash: candidate.id_hash,
      shop: candidate.shop,
      d1_before: d1Before,
    };
    assertNoSecretsInOutput(out);
    console.log(JSON.stringify(out));
    process.exit(1);
  }

  // Re-read Redis fingerprint immediately before write (dry-run↔apply safety)
  const mid = await readRedisInventory(redis);
  if (mid.inventory_fingerprint !== before.inventory_fingerprint) {
    const out = {
      type: "session_l41_seed_abort",
      mode,
      error: "redis_changed",
      fingerprint_before: before.inventory_fingerprint,
      fingerprint_now: mid.inventory_fingerprint,
    };
    assertNoSecretsInOutput(out);
    console.log(JSON.stringify(out));
    process.exit(1);
  }

  let didInsert = false;
  if (mode === "dry-run") {
    // no D1 write
  } else if (action === "insert") {
    if (REMOTE) {
      insertViaWrangler(candidate);
    } else {
      await insertViaLocalRepo(candidate);
    }
    didInsert = true;
  }

  const d1After = countD1Sessions();
  const after = await readRedisInventory(redis);
  const redisUnchanged =
    before.inventory_fingerprint === after.inventory_fingerprint &&
    JSON.stringify(before.counts) === JSON.stringify(after.counts);

  let verify: Record<string, unknown> | null = null;
  if (mode === "apply" && (didInsert || action === "identical_skip")) {
    verify = verifyD1AgainstCandidate(candidate);
  }

  const out = {
    type: "session_l41_seed_done",
    mode,
    target: REMOTE ? "remote" : "local",
    action:
      mode === "dry-run"
        ? action === "insert"
          ? "would_insert"
          : "identical_skip"
        : didInsert
          ? "inserted"
          : "identical_skip",
    id_hash: candidate.id_hash,
    shop: candidate.shop,
    is_online: candidate.is_online,
    has_expires: candidate.has_expires,
    entry_keys: candidate.entry_keys,
    fingerprint: candidate.fingerprint,
    d1_before: d1Before,
    d1_after: d1After,
    redis_before: before.counts,
    redis_after: after.counts,
    redis_ttl_new: before.ttls,
    redis_unchanged: redisUnchanged,
    redis_inventory_fingerprint: before.inventory_fingerprint,
    verify,
    target_shop: L41_TARGET_SHOP,
    target_id_hash: L41_TARGET_ID_HASH,
  };

  assertNoSecretsInOutput(out);
  console.log(JSON.stringify(out, null, 2));

  if (mode === "dry-run" && action !== "insert" && action !== "identical_skip") {
    process.exit(1);
  }
  if (mode === "apply" && verify && verify.fingerprint_match !== true) {
    process.exit(1);
  }
  if (!redisUnchanged) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/shpat_[^\s'"]+/g, "<redacted>").slice(0, 500));
  process.exit(1);
});
