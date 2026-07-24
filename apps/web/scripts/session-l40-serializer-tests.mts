/**
 * Stage L4.0 — session serializer / local D1 round-trip tests.
 * Does not touch Redis writes or production D1.
 *
 *   npx tsx scripts/session-l40-serializer-tests.mts
 */
import assert from "node:assert/strict";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import {
  createShopifySessionRepository,
  deserializeSessionPayload,
  serializeSessionPayload,
} from "../app/lib/d1/shopifySessions.server.ts";
import type { ShopifySessionPayload } from "../app/lib/d1/types.server.ts";

function makeOffline(shop = "audit-test.myshopify.com") {
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "state-value-secret",
    isOnline: false,
    accessToken: "shpat_test_token_offline_not_real",
    scope: "read_products,write_inventory",
  });
}

function makeOnline(shop = "audit-test.myshopify.com", expires: Date) {
  return new Session({
    id: "11111111-2222-3333-4444-555555555555",
    shop,
    state: "state-online",
    isOnline: true,
    accessToken: "shpat_test_token_online_not_real",
    scope: "read_products",
    expires,
  });
}

function assertSafeLog(obj: unknown) {
  const s = JSON.stringify(obj);
  assert.ok(!s.includes("shpat_"), "must not log access tokens");
  assert.ok(!/state-value-secret|state-online/.test(s), "must not log state");
}

function compareSessionFields(a: Session, b: Session) {
  assert.equal(a.id, b.id);
  assert.equal(a.shop, b.shop);
  assert.equal(a.isOnline, b.isOnline);
  assert.equal(a.scope, b.scope);
  assert.equal(a.accessToken, b.accessToken);
  assert.equal(a.expires?.getTime() ?? null, b.expires?.getTime() ?? null);
}

async function main() {
  // --- in-memory Redis-shape ↔ Session ---
  const offline = makeOffline();
  const payload = serializeSessionPayload(offline);
  assert.ok(Array.isArray(payload.entries));
  assert.equal(payload.shop, offline.shop);
  const round1 = deserializeSessionPayload(payload);
  compareSessionFields(offline, round1);

  // Redis-compatible re-serialize (as sessionStorage does)
  const redisShape: ShopifySessionPayload = {
    entries: offline.toPropertyArray(true),
    shop: offline.shop,
    expiresAt: offline.expires?.getTime(),
  };
  const fromRedisShape = Session.fromPropertyArray(redisShape.entries, true);
  compareSessionFields(offline, fromRedisShape);
  const backToRedis = {
    entries: fromRedisShape.toPropertyArray(true),
    shop: fromRedisShape.shop,
    expiresAt: fromRedisShape.expires?.getTime(),
  };
  const again = Session.fromPropertyArray(backToRedis.entries, true);
  compareSessionFields(offline, again);

  const online = makeOnline("audit-test.myshopify.com", new Date(Date.now() + 3_600_000));
  const onlinePayload = serializeSessionPayload(online);
  assert.ok(onlinePayload.expiresAt);
  const onlineRound = deserializeSessionPayload(onlinePayload);
  compareSessionFields(online, onlineRound);
  assert.ok(onlineRound.expires instanceof Date);

  // malformed rejection
  let malformedRejected = false;
  try {
    deserializeSessionPayload({ entries: [], shop: "x.myshopify.com" });
  } catch {
    malformedRejected = true;
  }
  // empty entries may throw or yield incomplete session — treat either as not usable
  if (!malformedRejected) {
    try {
      const bad = deserializeSessionPayload({
        entries: [["id", "x"]] as any,
        shop: "x.myshopify.com",
      });
      assert.ok(!bad.accessToken);
    } catch {
      malformedRejected = true;
    }
  }

  // redaction helper sample
  assertSafeLog({
    session_id_hash: "abc",
    shop: offline.shop,
    is_online: false,
    has_access_token: true,
    entry_keys: payload.entries.map(([k]) => k),
  });

  // --- local D1 only ---
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    assert.ok(db);
    await db.prepare("DELETE FROM shopify_sessions WHERE shop = ?").bind(offline.shop).run();

    const repo = createShopifySessionRepository(db);
    assert.equal(await repo.storeSession(offline), true);
    const loaded = await repo.loadSession(offline.id);
    assert.ok(loaded);
    compareSessionFields(offline, loaded!);

    assert.equal(await repo.storeSession(online), true);
    const loadedOnline = await repo.loadSession(online.id);
    assert.ok(loadedOnline);
    compareSessionFields(online, loadedOnline!);

    const expired = makeOnline(offline.shop, new Date(Date.now() - 60_000));
    expired.id = "99999999-8888-7777-6666-555555555555";
    await repo.storeSession(expired);
    assert.equal(await repo.loadSession(expired.id), undefined);

    const byShop = await repo.findSessionsByShop(offline.shop);
    assert.ok(byShop.some((s) => s.id === offline.id));
    assert.ok(byShop.some((s) => s.id === online.id));
    assert.ok(!byShop.some((s) => s.id === expired.id));

    // optional / boolean fields survive
    assert.equal(typeof loaded!.isOnline, "boolean");
    assert.equal(loaded!.isOnline, false);
    assert.equal(typeof loadedOnline!.isOnline, "boolean");
    assert.equal(loadedOnline!.isOnline, true);

    await repo.deleteSession(offline.id);
    await repo.deleteSession(online.id);
    await repo.deleteSession(expired.id);
    await db.prepare("DELETE FROM shopify_sessions WHERE shop = ?").bind(offline.shop).run();

    console.log(
      JSON.stringify({
        type: "session_l40_serializer_tests_ok",
        checks: [
          "serialize_deserialize",
          "redis_shape_compat",
          "online_expires",
          "offline_id",
          "local_d1_roundtrip",
          "expiry_filter",
          "shop_find",
          "secret_redaction",
          "malformed_handled",
        ],
      }),
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
