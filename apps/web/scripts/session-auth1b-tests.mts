/**
 * AUTH-1b — expiring Shopify offline session integration tests.
 * Local D1 and mocked Shopify refresh only; never contacts production.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "@shopify/shopify-api";
import { AppDistribution } from "@shopify/shopify-app-react-router/server";
import { getPlatformProxy } from "wrangler";
import {
  createShopifySessionRepository,
  serializeSessionPayload,
} from "../app/lib/d1/shopifySessions.server.ts";
import {
  hashSessionId,
  storeSessionD1Only,
} from "../app/lib/sessionD1Only.server.ts";

process.env.TOKEN_ENCRYPTION_KEY ??= "auth1b-local-test-key-32-bytes!!";
process.env.SHOPIFY_API_KEY ??= "auth1b-test-api-key";
process.env.SHOPIFY_API_SECRET ??= "auth1b-test-api-secret";
process.env.SCOPES ??= "read_products";
process.env.SHOPIFY_APP_URL ??= "https://auth1b.test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");
const libraryHelperPath = join(
  webRoot,
  "node_modules/@shopify/shopify-app-react-router/dist/esm/server/helpers/ensure-offline-token-is-not-expired.mjs",
);
const { ensureOfflineTokenIsNotExpired } = (await import(
  libraryHelperPath
)) as {
  ensureOfflineTokenIsNotExpired: (
    session: Session,
    params: unknown,
    shop: string,
  ) => Promise<Session>;
};

const SHOP_A = "auth1b-a.myshopify.com";
const SHOP_B = "auth1b-b.myshopify.com";
const OFFLINE_A = `offline_${SHOP_A}`;
const ACCESS_OLD = "shpat_auth1b_old_access";
const REFRESH_OLD = "auth1b_old_refresh_secret";

function makeExpiring(params?: {
  shop?: string;
  accessToken?: string;
  refreshToken?: string;
  expires?: Date;
  refreshTokenExpires?: Date;
}) {
  const shop = params?.shop ?? SHOP_A;
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "auth1b-state-secret",
    isOnline: false,
    accessToken: params?.accessToken ?? ACCESS_OLD,
    refreshToken: params?.refreshToken ?? REFRESH_OLD,
    expires: params?.expires ?? new Date(Date.now() + 60_000),
    refreshTokenExpires:
      params?.refreshTokenExpires ??
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    scope: "read_products,write_inventory",
  });
}

function assertExpiringRoundTrip(
  actual: Session | undefined,
  expected: Session,
) {
  assert.ok(actual);
  assert.equal(actual.id, expected.id);
  assert.equal(actual.shop, expected.shop);
  assert.equal(actual.accessToken, expected.accessToken);
  assert.equal(actual.refreshToken, expected.refreshToken);
  assert.equal(actual.expires?.getTime(), expected.expires?.getTime());
  assert.equal(
    actual.refreshTokenExpires?.getTime(),
    expected.refreshTokenExpires?.getTime(),
  );
  assert.equal(actual.scope, expected.scope);
}

function assertLibraryEntryPointsUseOfflineRefresh() {
  const files = [
    "node_modules/@shopify/shopify-app-react-router/src/server/authenticate/flow/authenticate.ts",
    "node_modules/@shopify/shopify-app-react-router/src/server/unauthenticated/admin/factory.ts",
    "node_modules/@shopify/shopify-app-react-router/src/server/authenticate/webhooks/authenticate.ts",
  ];
  for (const file of files) {
    const source = readFileSync(join(webRoot, file), "utf8");
    assert.ok(
      source.includes("ensureValidOfflineSession"),
      `${file} must use the official offline-session refresh helper`,
    );
  }
  const config = readFileSync(join(webRoot, "app/shopify.server.ts"), "utf8");
  assert.match(config, /expiringOfflineAccessTokens:\s*true/);
}

async function testTenantBoundary() {
  const routePath = join(webRoot, "app/routes/api.shopify.graphql.ts");
  const source = readFileSync(routePath, "utf8");
  assert.ok(!source.includes("unauthenticated.admin"));
  assert.ok(!source.includes('searchParams.get("shop_id")'));

  const { createShopifyGraphqlAction } =
    await import("../app/routes/api.shopify.graphql.ts");
  let authenticateCalls = 0;
  let graphqlCalls = 0;
  const action = createShopifyGraphqlAction(async () => {
    authenticateCalls += 1;
    throw new Error("authentication failed for test");
  });
  const response = await action({
    request: new Request(
      `https://auth1b.test/api/shopify/graphql?shop_id=${SHOP_B}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shop-id": SHOP_B,
        },
        body: JSON.stringify({
          shop_id: SHOP_B,
          query: "{ shop { name } }",
        }),
      },
    ),
    params: {},
    context: {},
  } as never);
  assert.equal(
    response instanceof Response
      ? response.status
      : (response as { init?: { status?: number } }).init?.status,
    401,
  );
  assert.equal(authenticateCalls, 1);
  assert.equal(graphqlCalls, 0);

  const successAction = createShopifyGraphqlAction(async () => ({
    admin: {
      async graphql() {
        graphqlCalls += 1;
        return Response.json({ data: { shop: { name: "A" } } });
      },
    },
  }));
  const success = await successAction({
    request: new Request("https://auth1b.test/api/shopify/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ shop { name } }" }),
    }),
    params: {},
    context: {},
  } as never);
  assert.equal(success.status, 200);
  assert.equal(graphqlCalls, 1);
}

async function main() {
  assertLibraryEntryPointsUseOfflineRefresh();
  await testTenantBoundary();

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop IN (?, ?)")
      .bind(SHOP_A, SHOP_B)
      .run();
    const repo = createShopifySessionRepository(db);

    // Expiring Session fields round-trip without plaintext token persistence.
    const initial = makeExpiring();
    assert.equal(await repo.storeSession(initial), true);
    const storedRow = await db
      .prepare(
        `SELECT payload_json, token_ciphertext, token_expires_at,
                token_fingerprint, token_generation
         FROM shopify_sessions WHERE id = ?`,
      )
      .bind(OFFLINE_A)
      .first<Record<string, unknown>>();
    assert.ok(storedRow?.token_ciphertext);
    const serializedRow = JSON.stringify(storedRow);
    assert.ok(!serializedRow.includes(ACCESS_OLD));
    assert.ok(!serializedRow.includes(REFRESH_OLD));
    assert.ok(!String(storedRow?.payload_json).includes('"accessToken"'));
    assert.ok(!String(storedRow?.payload_json).includes('"refreshToken"'));
    assert.equal(Number(storedRow?.token_generation), 1);
    assertExpiringRoundTrip(await repo.loadSession(OFFLINE_A), initial);

    // Legacy permanent-token rows remain readable until explicitly rewritten.
    const legacy = new Session({
      id: `offline_${SHOP_B}`,
      shop: SHOP_B,
      state: "legacy-state",
      isOnline: false,
      accessToken: "shpat_auth1b_legacy",
      scope: "read_products",
    });
    const legacyPayload = {
      entries: legacy.toPropertyArray(true),
      shop: SHOP_B,
    };
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO shopify_sessions (
           id, shop, payload_json, is_online, expires_at,
           migration_source, migration_version, created_at, updated_at
         ) VALUES (?, ?, ?, 0, NULL, 'runtime', 'l1-v1', ?, ?)`,
      )
      .bind(legacy.id, legacy.shop, JSON.stringify(legacyPayload), now, now)
      .run();
    assert.equal(
      (await repo.loadSession(legacy.id))?.accessToken,
      legacy.accessToken,
    );

    // Official helper skips refresh outside its five-minute window.
    let refreshCalls = 0;
    let storeCalls = 0;
    const valid = makeExpiring({
      expires: new Date(Date.now() + 10 * 60 * 1000),
    });
    const commonConfig = {
      future: { expiringOfflineAccessTokens: true },
      distribution: AppDistribution.AppStore,
      sessionStorage: {
        async storeSession(session: Session) {
          storeCalls += 1;
          return repo.storeSession(session);
        },
      },
    };
    const noRefreshResult = await ensureOfflineTokenIsNotExpired(
      valid,
      {
        config: commonConfig,
        api: {
          auth: {
            async refreshToken() {
              refreshCalls += 1;
              return { session: valid };
            },
          },
        },
      },
      SHOP_A,
    );
    assert.equal(noRefreshResult, valid);
    assert.equal(refreshCalls, 0);
    assert.equal(storeCalls, 0);

    // Official helper refreshes and persists the rotated tuple.
    const rotated = makeExpiring({
      accessToken: "shpat_auth1b_rotated",
      refreshToken: "auth1b_rotated_refresh",
      expires: new Date(Date.now() + 60 * 60 * 1000),
    });
    const refreshResult = await ensureOfflineTokenIsNotExpired(
      initial,
      {
        config: commonConfig,
        api: {
          auth: {
            async refreshToken(input: { shop: string; refreshToken: string }) {
              refreshCalls += 1;
              assert.deepEqual(input, {
                shop: SHOP_A,
                refreshToken: REFRESH_OLD,
              });
              return { session: rotated };
            },
          },
        },
      },
      SHOP_A,
    );
    assert.equal(refreshResult.refreshToken, rotated.refreshToken);
    assertExpiringRoundTrip(await repo.loadSession(OFFLINE_A), rotated);

    // A direct stale write is rejected before the concurrent helper test.
    const stale = makeExpiring({
      accessToken: "shpat_auth1b_stale",
      refreshToken: "auth1b_stale_refresh",
      expires: new Date(Date.now() + 20 * 60 * 1000),
    });
    assert.equal(await repo.storeSession(stale), false);
    assertExpiringRoundTrip(await repo.loadSession(OFFLINE_A), rotated);

    // A delayed legacy/permanent write cannot downgrade an expiring session.
    const delayedPermanent = new Session({
      id: OFFLINE_A,
      shop: SHOP_A,
      state: "delayed-legacy-state",
      isOnline: false,
      accessToken: "shpat_auth1b_delayed_permanent",
      scope: "read_products",
    });
    assert.equal(await repo.storeSession(delayedPermanent), false);
    assertExpiringRoundTrip(await repo.loadSession(OFFLINE_A), rotated);

    // Reproduce official-library concurrency: both calls reach refresh.
    // The newer tuple stores first; the older late response is rejected by CAS.
    const raceShop = "auth1b-race.myshopify.com";
    const raceId = `offline_${raceShop}`;
    await db
      .prepare("DELETE FROM shopify_sessions WHERE id = ?")
      .bind(raceId)
      .run();
    const raceInitial = makeExpiring({
      shop: raceShop,
      accessToken: "shpat_auth1b_race_initial",
      refreshToken: "auth1b_race_initial_refresh",
      expires: new Date(Date.now() + 60_000),
    });
    assert.equal(await repo.storeSession(raceInitial), true);
    const older = makeExpiring({
      shop: raceShop,
      accessToken: "shpat_auth1b_race_older",
      refreshToken: "auth1b_race_older_refresh",
      expires: new Date(Date.now() + 30 * 60 * 1000),
    });
    const newer = makeExpiring({
      shop: raceShop,
      accessToken: "shpat_auth1b_race_newer",
      refreshToken: "auth1b_race_newer_refresh",
      expires: new Date(Date.now() + 60 * 60 * 1000),
    });
    let raceRefreshCalls = 0;
    const raceStoreResults: boolean[] = [];
    const raceParams = {
      config: {
        future: { expiringOfflineAccessTokens: true },
        distribution: AppDistribution.AppStore,
        sessionStorage: {
          async storeSession(session: Session) {
            const stored = await repo.storeSession(session);
            raceStoreResults.push(stored);
            return stored;
          },
        },
      },
      api: {
        auth: {
          async refreshToken() {
            raceRefreshCalls += 1;
            const call = raceRefreshCalls;
            await new Promise((resolve) =>
              setTimeout(resolve, call === 1 ? 40 : 5),
            );
            return { session: call === 1 ? older : newer };
          },
        },
      },
    };
    await Promise.all([
      ensureOfflineTokenIsNotExpired(raceInitial, raceParams, raceShop),
      ensureOfflineTokenIsNotExpired(raceInitial, raceParams, raceShop),
    ]);
    assert.equal(raceRefreshCalls, 2, "official helper has no cross-call lock");
    assert.deepEqual(raceStoreResults.sort(), [false, true]);
    assertExpiringRoundTrip(await repo.loadSession(raceId), newer);

    const raceRow = await db
      .prepare(
        `SELECT token_generation, payload_json, token_ciphertext
         FROM shopify_sessions WHERE id = ?`,
      )
      .bind(raceId)
      .first<Record<string, unknown>>();
    assert.equal(Number(raceRow?.token_generation), 2);
    const raceRaw = JSON.stringify(raceRow);
    assert.ok(!raceRaw.includes("shpat_auth1b"));
    assert.ok(!raceRaw.includes("auth1b_race_"));

    // Shop isolation and structured session logs do not expose tokens.
    assert.equal((await repo.loadSession(legacy.id))?.shop, SHOP_B);
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      assert.equal(
        await storeSessionD1Only({
          session: newer,
          db,
        }),
        true,
      );
    } finally {
      console.log = originalLog;
    }
    const logText = logged.join("\n");
    assert.ok(logText.includes(hashSessionId(raceId)));
    assert.ok(!logText.includes(newer.accessToken!));
    assert.ok(!logText.includes(newer.refreshToken!));

    const safePayload = serializeSessionPayload(newer);
    assert.ok(!JSON.stringify(safePayload).includes(newer.accessToken!));
    assert.ok(!JSON.stringify(safePayload).includes(newer.refreshToken!));

    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop IN (?, ?, ?)")
      .bind(SHOP_A, SHOP_B, raceShop)
      .run();

    console.log(
      JSON.stringify({
        type: "session_auth1b_tests_ok",
        checks: [
          "expiring_roundtrip",
          "encrypted_at_rest",
          "legacy_compat",
          "official_refresh_window",
          "official_rotation_persistence",
          "concurrent_refresh_reproduced",
          "stale_rotation_cas",
          "shop_isolation",
          "token_log_redaction",
          "authenticated_unauthenticated_webhook_contract",
          "tenant_fallback_removed",
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
