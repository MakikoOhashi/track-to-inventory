/**
 * Stage L4.1 unit tests for session seed selection / conflict / redaction.
 *   npx tsx scripts/session-l41-seed-tests.mts
 */
import assert from "node:assert/strict";
import { Session } from "@shopify/shopify-api";
import { createHash } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import { createShopifySessionRepository } from "../app/lib/d1/shopifySessions.server.ts";
import {
  assertNoSecretsInOutput,
  classifyD1Conflict,
  hashSessionId,
  L41_TARGET_ID_HASH,
  L41_TARGET_SHOP,
  selectL41Candidate,
  sessionFingerprint,
  type D1ExistingSafe,
} from "./lib/sessionSeedCore.mts";

process.env.TOKEN_ENCRYPTION_KEY ??= "auth1b-local-test-key-32-bytes!!";

function makeOffline(shop: string, id?: string) {
  const sessionId = id ?? `offline_${shop}`;
  return new Session({
    id: sessionId,
    shop,
    state: "secret-state",
    isOnline: false,
    accessToken: "shpat_unit_test_token",
    scope: "read_products,write_inventory",
  });
}

function payloadOf(session: Session) {
  return {
    entries: session.toPropertyArray(true),
    shop: session.shop,
    expiresAt: session.expires?.getTime(),
  };
}

async function main() {
  // Target hash must match real audit hash when using real shop id pattern —
  // for unit tests we override targetIdHash to the fixture's hash.
  const shop = L41_TARGET_SHOP;
  const offline = makeOffline(shop);
  const idHash = hashSessionId(offline.id);

  const ok = selectL41Candidate({
    newSessions: [{ id: offline.id, payload: payloadOf(offline) }],
    legacyById: new Map([[offline.id, payloadOf(offline)]]),
    targetShop: shop,
    targetIdHash: idHash,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.candidate.shop, shop);
    assert.equal(ok.candidate.is_online, false);
  }

  // zero
  const zero = selectL41Candidate({
    newSessions: [],
    legacyById: new Map(),
    targetIdHash: idHash,
  });
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.equal(zero.error, "zero_candidates");

  // hash mismatch → zero candidates for that hash
  const hashMiss = selectL41Candidate({
    newSessions: [{ id: offline.id, payload: payloadOf(offline) }],
    legacyById: new Map(),
    targetIdHash: "deadbeefdeadbeef",
  });
  assert.equal(hashMiss.ok, false);

  // shop mismatch
  const other = makeOffline(
    "other.myshopify.com",
    `offline_other.myshopify.com`,
  );
  // Force same hash collision unlikely — use target hash of other but target shop wrong
  const shopMiss = selectL41Candidate({
    newSessions: [{ id: other.id, payload: payloadOf(other) }],
    legacyById: new Map(),
    targetShop: shop,
    targetIdHash: hashSessionId(other.id),
  });
  assert.equal(shopMiss.ok, false);
  if (!shopMiss.ok) assert.equal(shopMiss.error, "shop_mismatch");

  // online rejected
  const online = new Session({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    shop,
    state: "s",
    isOnline: true,
    accessToken: "shpat_online",
    scope: "read_products",
    expires: new Date(Date.now() + 60_000),
  });
  const onlineSel = selectL41Candidate({
    newSessions: [{ id: online.id, payload: payloadOf(online) }],
    legacyById: new Map(),
    targetShop: shop,
    targetIdHash: hashSessionId(online.id),
  });
  assert.equal(onlineSel.ok, false);
  if (!onlineSel.ok) assert.equal(onlineSel.error, "online_session");

  // namespace mismatch
  const legacyDifferent = makeOffline(shop);
  // mutate scope in legacy copy
  const legacyPayload = payloadOf(legacyDifferent);
  legacyPayload.entries = legacyPayload.entries.map(([k, v]) =>
    k === "scope" ? [k, "read_products"] : [k, v],
  ) as typeof legacyPayload.entries;
  const mismatch = selectL41Candidate({
    newSessions: [{ id: offline.id, payload: payloadOf(offline) }],
    legacyById: new Map([[offline.id, legacyPayload]]),
    targetShop: shop,
    targetIdHash: idHash,
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error, "namespace_mismatch");

  // malformed
  const malformed = selectL41Candidate({
    newSessions: [{ id: offline.id, payload: { nope: true } }],
    legacyById: new Map(),
    targetIdHash: idHash,
  });
  assert.equal(malformed.ok, false);

  // conflict classification
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(classifyD1Conflict(ok.candidate, null), "insert");
    const existing: D1ExistingSafe = {
      id_hash: ok.candidate.id_hash,
      shop: ok.candidate.shop,
      is_online: false,
      expires_at: null,
      fingerprint: ok.candidate.fingerprint,
    };
    assert.equal(classifyD1Conflict(ok.candidate, existing), "identical_skip");
    assert.equal(
      classifyD1Conflict(ok.candidate, { ...existing, fingerprint: "x" }),
      "conflict",
    );
  }

  // redaction
  assertNoSecretsInOutput({
    id_hash: idHash,
    shop,
    action: "would_insert",
    entry_keys: ["accessToken", "id", "isOnline", "scope", "shop", "state"],
  });
  let leaked = false;
  try {
    assertNoSecretsInOutput({ token: "shpat_leak" });
  } catch {
    leaked = true;
  }
  assert.ok(leaked);

  // Production target hash constant still matches audit expectation shape
  assert.equal(L41_TARGET_ID_HASH.length, 16);
  assert.equal(
    createHash("sha256").update("x").digest("hex").slice(0, 16).length,
    16,
  );

  // local D1 insert-only round-trip (dry-run write 0 is script-level; here apply local)
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
      .bind(shop)
      .run();
    const repo = createShopifySessionRepository(db);
    await repo.storeSession(offline);
    const loaded = await repo.loadSession(offline.id);
    assert.ok(loaded);
    assert.equal(hashSessionId(loaded!.id), idHash);
    assert.equal(loaded!.isOnline, false);
    const fp = sessionFingerprint(
      loaded!,
      payloadOf(loaded!).entries.map(([k]) => String(k)),
    );
    assert.equal(
      fp,
      sessionFingerprint(
        offline,
        payloadOf(offline).entries.map(([k]) => String(k)),
      ),
    );
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
      .bind(shop)
      .run();
  } finally {
    await proxy.dispose();
  }

  console.log(
    JSON.stringify({
      type: "session_l41_seed_tests_ok",
      checks: [
        "select_ok",
        "zero",
        "hash_miss",
        "shop_miss",
        "online",
        "namespace_mismatch",
        "malformed",
        "conflict",
        "redaction",
        "local_d1",
      ],
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
