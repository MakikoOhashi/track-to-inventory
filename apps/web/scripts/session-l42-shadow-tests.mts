/**
 * Stage L4.2 session D1 shadow tests (local D1 + in-memory classify).
 *   npm run test:session:l42
 */
import assert from "node:assert/strict";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import { runWithCloudflareEnv } from "../app/lib/cloudflareBindings.server.ts";
import { createShopifySessionRepository } from "../app/lib/d1/shopifySessions.server.ts";
import {
  getSessionD1Mode,
  isSessionD1ShadowActive,
} from "../app/lib/sessionD1Mode.server.ts";
import {
  classifySessionShadow,
  compareSessionToD1,
  hashSessionId,
  resetSessionShadowMatchLogCount,
  runSessionD1ShadowForTest,
  snapFromSession,
  SESSION_D1_SHADOW_TIMEOUT_MS,
} from "../app/lib/sessionD1Shadow.server.ts";

function makeOffline(shop = "l42-test.myshopify.com") {
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "state-secret-l42",
    isOnline: false,
    accessToken: "shpat_l42_offline_token",
    scope: "read_products,write_inventory",
  });
}

function assertSafe(obj: unknown) {
  const s = JSON.stringify(obj);
  assert.ok(!s.includes("shpat_"));
  assert.ok(!s.includes("state-secret"));
}

async function main() {
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "shadow" }), "shadow");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "primary" }), "off");
  assert.equal(getSessionD1Mode({ SESSION_D1_MODE: "nope" }), "off");
  assert.equal(SESSION_D1_SHADOW_TIMEOUT_MS, 200);

  const a = makeOffline();
  const b = makeOffline();
  assert.equal(classifySessionShadow(snapFromSession(a), snapFromSession(b)), "match");

  const otherShop = makeOffline("other.myshopify.com");
  assert.equal(
    classifySessionShadow(snapFromSession(a), snapFromSession(otherShop)),
    "shop_mismatch",
  );

  const online = new Session({
    id: a.id,
    shop: a.shop,
    state: "s",
    isOnline: true,
    accessToken: a.accessToken,
    scope: a.scope,
    expires: new Date(Date.now() + 60_000),
  });
  assert.equal(
    classifySessionShadow(snapFromSession(a), snapFromSession(online)),
    "online_mismatch",
  );

  const scopeDiff = new Session({
    id: a.id,
    shop: a.shop,
    state: "state-secret-l42",
    isOnline: false,
    accessToken: "shpat_l42_offline_token",
    scope: "read_products",
  });
  assert.equal(
    classifySessionShadow(snapFromSession(a), snapFromSession(scopeDiff)),
    "scope_mismatch",
  );

  const tokenDiff = new Session({
    id: a.id,
    shop: a.shop,
    state: "state-secret-l42",
    isOnline: false,
    accessToken: "shpat_other_token",
    scope: a.scope,
  });
  assert.equal(
    classifySessionShadow(snapFromSession(a), snapFromSession(tokenDiff)),
    "token_mismatch",
  );

  const stateDiff = new Session({
    id: a.id,
    shop: a.shop,
    state: "other-state",
    isOnline: false,
    accessToken: "shpat_l42_offline_token",
    scope: a.scope,
  });
  assert.equal(
    classifySessionShadow(snapFromSession(a), snapFromSession(stateDiff)),
    "state_mismatch",
  );

  assert.equal(classifySessionShadow(snapFromSession(a), null), "missing_in_d1");
  assert.equal(classifySessionShadow(null, snapFromSession(a)), "missing_in_redis");

  assertSafe(snapFromSession(a));

  // off → skipped
  process.env.SESSION_D1_MODE = "off";
  assert.equal(isSessionD1ShadowActive(), false);
  assert.equal(
    await runSessionD1ShadowForTest({
      sessionId: a.id,
      redisSession: a,
      primaryNamespace: "tti",
    }),
    "skipped",
  );

  process.env.SESSION_D1_MODE = "shadow";
  resetSessionShadowMatchLogCount();

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await db.prepare("DELETE FROM shopify_sessions WHERE shop = ?").bind(a.shop).run();
    const repo = createShopifySessionRepository(db);
    await repo.storeSession(a);

    // match
    const matchCat = await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () =>
        runSessionD1ShadowForTest({
          sessionId: a.id,
          redisSession: a,
          primaryNamespace: "tti",
        }),
    );
    assert.equal(matchCat, "match");

    // missing in d1
    const miss = await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () =>
        runSessionD1ShadowForTest({
          sessionId: "offline_missing.myshopify.com",
          redisSession: makeOffline("missing.myshopify.com"),
          primaryNamespace: "tti",
        }),
    );
    assert.equal(miss, "missing_in_d1");

    // token mismatch on D1
    await repo.storeSession(tokenDiff);
    const tok = await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () =>
        runSessionD1ShadowForTest({
          sessionId: a.id,
          redisSession: a,
          primaryNamespace: "tti",
        }),
    );
    assert.equal(tok, "token_mismatch");

    // Redis miss + D1 hit → missing_in_redis, caller would still return undefined
    await repo.storeSession(a);
    const redisMiss = await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () =>
        compareSessionToD1({
          sessionId: a.id,
          redisSession: undefined,
          primaryNamespace: "miss",
        }),
    );
    assert.equal(redisMiss, "missing_in_redis");

    // binding missing
    const bindMiss = await runWithCloudflareEnv(
      { env: {} as Env, ctx: {} as ExecutionContext },
      () =>
        runSessionD1ShadowForTest({
          sessionId: a.id,
          redisSession: a,
          primaryNamespace: "tti",
        }),
    );
    assert.equal(bindMiss, "d1_error");

    // logging failure path — snap still safe
    assert.equal(hashSessionId(a.id).length, 16);

    await db.prepare("DELETE FROM shopify_sessions WHERE shop = ?").bind(a.shop).run();
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
      .bind("missing.myshopify.com")
      .run();

    console.log(
      JSON.stringify({
        type: "session_l42_shadow_tests_ok",
        timeout_ms: SESSION_D1_SHADOW_TIMEOUT_MS,
        checks: [
          "mode",
          "match",
          "shop_mismatch",
          "online_mismatch",
          "scope_mismatch",
          "token_mismatch",
          "state_mismatch",
          "missing_in_d1",
          "missing_in_redis",
          "binding_missing",
          "shadow_off",
          "secret_redaction",
        ],
      }),
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
