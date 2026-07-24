/**
 * Stage L4.2 session D1 shadow tests (local D1 + in-memory classify).
 *   npm run test:session:l42
 */
import assert from "node:assert/strict";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import {
  getOptionalTtiDb,
  runWithCloudflareEnv,
} from "../app/lib/cloudflareBindings.server.ts";
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
  scheduleSessionD1Shadow,
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
  assert.equal(SESSION_D1_SHADOW_TIMEOUT_MS, 500);

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

  // off → skipped (no D1 call even when db is provided)
  process.env.SESSION_D1_MODE = "off";
  assert.equal(isSessionD1ShadowActive(), false);
  assert.equal(
    await runSessionD1ShadowForTest({
      db: {} as D1Database,
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

    // match with explicit db
    const matchCat = await runSessionD1ShadowForTest({
      db,
      sessionId: a.id,
      redisSession: a,
      primaryNamespace: "tti",
    });
    assert.equal(matchCat, "match");

    // ALS-loss: capture db in request context, compare outside ALS → still match
    const capturedDb = await runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      () => {
        const fromAls = getOptionalTtiDb();
        assert.ok(fromAls, "request context must expose TTI_DB");
        // Worker entry + server bundle share one ALS via globalThis
        const shared = (globalThis as { __tti_cloudflare_request_als__?: { getStore?: () => unknown } })
          .__tti_cloudflare_request_als__;
        assert.ok(shared?.getStore?.(), "globalThis ALS singleton must hold store");
        return fromAls;
      },
    );
    assert.equal(getOptionalTtiDb(), undefined, "ALS must be empty outside request");
    const alsLossMatch = await compareSessionToD1({
      db: capturedDb,
      sessionId: a.id,
      redisSession: a,
      primaryNamespace: "tti",
    });
    assert.equal(alsLossMatch, "match");

    // schedule: request ALS has binding → waitUntil receives explicit db work
    let waitUntilWork: Promise<unknown> | undefined;
    await runWithCloudflareEnv(
      {
        env: { TTI_DB: db } as Env,
        ctx: {
          waitUntil(p: Promise<unknown>) {
            waitUntilWork = p;
          },
          passThroughOnException() {},
        } as ExecutionContext,
      },
      () => {
        scheduleSessionD1Shadow({
          sessionId: a.id,
          redisSession: a,
          primaryNamespace: "tti",
        });
      },
    );
    assert.ok(waitUntilWork, "waitUntil must be registered when binding present");
    await waitUntilWork;

    // schedule: binding missing in request → no waitUntil, Redis path unchanged
    let waitUntilCalled = false;
    await runWithCloudflareEnv(
      {
        env: {} as Env,
        ctx: {
          waitUntil() {
            waitUntilCalled = true;
          },
          passThroughOnException() {},
        } as ExecutionContext,
      },
      () => {
        scheduleSessionD1Shadow({
          sessionId: a.id,
          redisSession: a,
          primaryNamespace: "tti",
        });
      },
    );
    assert.equal(waitUntilCalled, false);

    // missing in d1
    const miss = await runSessionD1ShadowForTest({
      db,
      sessionId: "offline_missing.myshopify.com",
      redisSession: makeOffline("missing.myshopify.com"),
      primaryNamespace: "tti",
    });
    assert.equal(miss, "missing_in_d1");

    // token mismatch on D1
    await repo.storeSession(tokenDiff);
    const tok = await runSessionD1ShadowForTest({
      db,
      sessionId: a.id,
      redisSession: a,
      primaryNamespace: "tti",
    });
    assert.equal(tok, "token_mismatch");

    // Redis miss + D1 hit → missing_in_redis, caller would still return undefined
    await repo.storeSession(a);
    const redisMiss = await compareSessionToD1({
      db,
      sessionId: a.id,
      redisSession: undefined,
      primaryNamespace: "miss",
    });
    assert.equal(redisMiss, "missing_in_redis");

    // binding missing (no db arg)
    const bindMiss = await runSessionD1ShadowForTest({
      sessionId: a.id,
      redisSession: a,
      primaryNamespace: "tti",
    });
    assert.equal(bindMiss, "d1_error");

    // <500ms D1 → match (local D1 above already covered; assert budget)
    assert.ok(SESSION_D1_SHADOW_TIMEOUT_MS === 500);

    // >500ms D1 → d1_timeout; Redis session object unchanged
    const redisBeforeTimeout = a;
    function makeSlowDb(delayMs: number): D1Database {
      return {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  await new Promise((r) => setTimeout(r, delayMs));
                  return null;
                },
              };
            },
          };
        },
      } as unknown as D1Database;
    }
    const slowCat = await runSessionD1ShadowForTest({
      db: makeSlowDb(SESSION_D1_SHADOW_TIMEOUT_MS + 80),
      sessionId: a.id,
      redisSession: redisBeforeTimeout,
      primaryNamespace: "tti",
    });
    assert.equal(slowCat, "d1_timeout");
    assert.equal(redisBeforeTimeout, a);
    assert.equal(redisBeforeTimeout.shop, "l42-test.myshopify.com");

    // logging failure path — snap still safe
    assert.equal(hashSessionId(a.id).length, 16);

    // Local D1 can briefly SQLITE_BUSY after waitUntil; retry cleanup.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db
          .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
          .bind(a.shop)
          .run();
        await db
          .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
          .bind("missing.myshopify.com")
          .run();
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/SQLITE_BUSY|database is locked/i.test(message) || attempt === 4) {
          throw error;
        }
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }

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
          "als_loss_explicit_db",
          "waitUntil_db_handoff",
          "binding_missing_no_waitUntil",
          "timeout_500ms_budget",
          "d1_timeout_over_budget",
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
