/**
 * Stage L4.4a — production read-only Redis ↔ D1 fingerprint compare.
 * Does not change SESSION_D1_MODE, does not write Redis/D1.
 *
 *   npx tsx --env-file=.env.local scripts/session-l44a-readonly-compare.mts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { Redis } from "@upstash/redis";
import { Session } from "@shopify/shopify-api";
import { createShopifySessionRepository } from "../app/lib/d1/shopifySessions.server.ts";
import {
  assertSafe,
  fingerprint,
  L43C_OPS_CONFIG,
  L43C_TARGET_HASH,
  L43C_TARGET_SHOP,
  parseJsoncFile,
  readD1Binding,
  snapFromDb,
  type StoredSessionPayload,
} from "./lib/sessionL43cOpsGate.mts";
import { hashSessionId } from "../app/lib/sessionD1Shadow.server.ts";
import {
  shopifySessionKey,
  shopifySessionKeyLegacy,
} from "../app/lib/redisKeys.server.ts";
import { L44B_GATE_CRITERIA, L44B_ROLLBACK_MODE } from "../app/lib/sessionL44bGate.server.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const webRoot = join(__dirname, "..");

async function loadRedisSession(id: string): Promise<Session | undefined> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.ok(url && token, "Upstash Redis env required");
  const redis = new Redis({ url, token });
  const neu = (await redis.get(shopifySessionKey(id))) as StoredSessionPayload | null;
  if (neu?.entries) return Session.fromPropertyArray(neu.entries, true);
  const legacy = (await redis.get(
    shopifySessionKeyLegacy(id),
  )) as StoredSessionPayload | null;
  if (legacy?.entries) return Session.fromPropertyArray(legacy.entries, true);
  return undefined;
}

async function main() {
  const opsConfig = join(webRoot, L43C_OPS_CONFIG);
  const mainConfig = join(webRoot, "wrangler.jsonc");
  const mainVars = (parseJsoncFile(mainConfig).vars || {}) as Record<string, string>;
  assert.equal(
    mainVars.SESSION_D1_MODE,
    "dual_write",
    "prod wrangler must remain dual_write for L4.4a",
  );
  assert.equal(L44B_ROLLBACK_MODE, "dual_write");

  const d1 = readD1Binding(opsConfig);
  assert.equal(d1.remote, true, "ops config must use remote D1");

  const proxy = await getPlatformProxy({
    configPath: opsConfig,
    persist: false,
    remoteBindings: true,
  });

  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    const snap = await snapFromDb(db);
    const repo = createShopifySessionRepository(db);

    // Resolve offline session id from shop (hash gate)
    const sessions = await repo.findSessionsByShop(L43C_TARGET_SHOP);
    const offline = sessions.find((s) => !s.isOnline);
    assert.ok(offline, "offline session must exist in remote D1");
    const idHash = hashSessionId(offline.id);
    assert.equal(idHash, L43C_TARGET_HASH, "target session hash mismatch");

    const d1Inspect = await repo.inspectSession(offline.id);
    assert.equal(d1Inspect.status, "live", "D1 target must be live");

    const redisSession = await loadRedisSession(offline.id);
    assert.ok(redisSession, "Redis must still hold target session");

    const d1Fp = fingerprint(d1Inspect.session);
    const redisFp = fingerprint(redisSession);

    const report = {
      type: "session_l44a_readonly_compare",
      shop: L43C_TARGET_SHOP,
      session_id_hash: idHash,
      d1_live_count: snap.live_count,
      d1_dup_count: snap.dup_count,
      d1_migration_source: snap.migration_source,
      d1_updated_at: snap.updated_at,
      ledger_succeeded: snap.ledger_succeeded,
      fingerprint_match: d1Fp === redisFp,
      d1_fingerprint: d1Fp,
      redis_fingerprint: redisFp,
      wrangler_session_mode: mainVars.SESSION_D1_MODE,
      writes: 0,
      l44b_gate_criteria_defined: L44B_GATE_CRITERIA.length,
      note: "read-only; SESSION_D1_MODE not changed; d1_primary not enabled in prod",
    };
    assertSafe(report);
    console.log(JSON.stringify(report, null, 2));

    assert.equal(report.fingerprint_match, true);
    assert.equal(report.d1_live_count, 1);
    assert.equal(report.d1_dup_count, 0);
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
