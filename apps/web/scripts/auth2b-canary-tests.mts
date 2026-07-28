/** AUTH-2b local-only canary operator tests. No Shopify or production calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import {
  AUTH2B_CANARY_SHOP,
  runAuth2bCanaryExchange,
  type Auth2bCanaryDependencies,
  type Auth2bCanaryRow,
} from "../app/lib/auth2bCanaryExchange.server.ts";
import { createShopifySessionRepository } from "../app/lib/d1/shopifySessions.server.ts";

process.env.TOKEN_ENCRYPTION_KEY ??= "auth1b-local-test-key-32-bytes!!";

const webRoot = join(process.cwd());
const LEGACY_TOKEN = "shpat_auth2b_legacy_test_only";
const REFRESH_TOKEN = "auth2b_refresh_test_only";

function legacySession() {
  return new Session({
    id: `offline_${AUTH2B_CANARY_SHOP}`,
    shop: AUTH2B_CANARY_SHOP,
    state: "auth2b-test-state",
    isOnline: false,
    accessToken: LEGACY_TOKEN,
    scope: "read_products",
  });
}

function expiringSession() {
  return new Session({
    id: `offline_${AUTH2B_CANARY_SHOP}`,
    shop: AUTH2B_CANARY_SHOP,
    state: "",
    isOnline: false,
    accessToken: "shpat_auth2b_new_test_only",
    refreshToken: REFRESH_TOKEN,
    expires: new Date(Date.now() + 60 * 60 * 1000),
    refreshTokenExpires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    scope: "read_products",
  });
}

function row(overrides: Partial<Auth2bCanaryRow> = {}): Auth2bCanaryRow {
  return {
    id: `offline_${AUTH2B_CANARY_SHOP}`,
    shop: AUTH2B_CANARY_SHOP,
    isOnline: false,
    tokenCiphertext: null,
    tokenExpiresAt: null,
    tokenFingerprint: null,
    tokenGeneration: 0,
    ...overrides,
  };
}

function mockDeps(
  overrides: {
    inspectedRow?: Auth2bCanaryRow | null;
    inspectedSession?: Session;
    migrate?: (params: {
      shop: string;
      nonExpiringOfflineAccessToken: string;
    }) => Promise<{ session: Session }>;
    store?: (session: Session) => Promise<boolean>;
    acquireLock?: () => Promise<boolean>;
    releaseLock?: () => Promise<void>;
  } = {},
): Auth2bCanaryDependencies & { calls: { migrate: number; store: number } } {
  const calls = { migrate: 0, store: 0 };
  return {
    calls,
    inspectSchema: async () => true,
    inspect: async () => ({
      row: overrides.inspectedRow ?? row(),
      session: overrides.inspectedSession ?? legacySession(),
    }),
    migrateToExpiringToken: async (params) => {
      calls.migrate += 1;
      assert.equal(params.shop, AUTH2B_CANARY_SHOP);
      assert.equal(params.nonExpiringOfflineAccessToken, LEGACY_TOKEN);
      return overrides.migrate
        ? overrides.migrate(params)
        : { session: expiringSession() };
    },
    storeSession: async (session) => {
      calls.store += 1;
      return overrides.store ? overrides.store(session) : true;
    },
    acquireLock: overrides.acquireLock,
    releaseLock: overrides.releaseLock,
  };
}

async function testLocalCustomSessionStorage() {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
      .bind(AUTH2B_CANARY_SHOP)
      .run();
    const repository = createShopifySessionRepository(db);
    const legacy = legacySession();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO shopify_sessions (
           id, shop, payload_json, is_online, expires_at,
           migration_source, migration_version, created_at, updated_at
         ) VALUES (?, ?, ?, 0, NULL, 'runtime', 'l1-v1', ?, ?)`,
      )
      .bind(
        legacy.id,
        legacy.shop,
        JSON.stringify({
          entries: legacy.toPropertyArray(true),
          shop: legacy.shop,
        }),
        now,
        now,
      )
      .run();

    const deps: Auth2bCanaryDependencies = {
      inspectSchema: async () => true,
      inspect: async () => {
        const inspected = await repository.inspectSession(legacy.id);
        assert.equal(inspected.status, "live");
        if (inspected.status !== "live") return { row: null };
        return {
          row: {
            id: inspected.row.id,
            shop: inspected.row.shop,
            isOnline: inspected.row.is_online === 1,
            tokenCiphertext: inspected.row.token_ciphertext,
            tokenExpiresAt: inspected.row.token_expires_at,
            tokenFingerprint: inspected.row.token_fingerprint,
            tokenGeneration: inspected.row.token_generation,
          },
          session: inspected.session,
        };
      },
      migrateToExpiringToken: async () => ({ session: expiringSession() }),
      storeSession: (session) => repository.storeSession(session),
    };

    const dry = await runAuth2bCanaryExchange(deps);
    assert.equal(dry.type, "auth2b_canary_eligible");
    const migrated = await runAuth2bCanaryExchange(deps, { execute: true });
    assert.equal(migrated.type, "auth2b_canary_exchange_stored");
    const loaded = await repository.loadSession(legacy.id);
    assert.equal(loaded?.refreshToken, REFRESH_TOKEN);
    const safeRow = await db
      .prepare(
        "SELECT payload_json, token_ciphertext, token_generation FROM shopify_sessions WHERE id = ?",
      )
      .bind(legacy.id)
      .first<Record<string, unknown>>();
    assert.equal(Number(safeRow?.token_generation), 1);
    assert.ok(safeRow?.token_ciphertext);
    assert.ok(!String(safeRow?.payload_json).includes('"accessToken"'));
    assert.ok(!String(safeRow?.payload_json).includes('"refreshToken"'));
    assert.ok(!JSON.stringify(safeRow).includes(LEGACY_TOKEN));
    assert.ok(!JSON.stringify(safeRow).includes(REFRESH_TOKEN));
    await db
      .prepare("DELETE FROM shopify_sessions WHERE shop = ?")
      .bind(AUTH2B_CANARY_SHOP)
      .run();
  } finally {
    await proxy.dispose();
  }
}

async function testMockSafetyCases() {
  const dryDeps = mockDeps();
  const dry = await runAuth2bCanaryExchange(dryDeps);
  assert.equal(dry.type, "auth2b_canary_eligible");
  assert.equal(dryDeps.calls.migrate, 0);
  assert.equal(dryDeps.calls.store, 0);

  const successDeps = mockDeps();
  const success = await runAuth2bCanaryExchange(successDeps, { execute: true });
  assert.equal(success.type, "auth2b_canary_exchange_stored");
  assert.equal(successDeps.calls.migrate, 1);
  assert.equal(successDeps.calls.store, 1);

  const rerunDeps = mockDeps({ inspectedRow: row({ tokenGeneration: 1 }) });
  const rerun = await runAuth2bCanaryExchange(rerunDeps, { execute: true });
  assert.equal(rerun.error, "already_exchanged_or_generation_not_zero");
  assert.equal(rerunDeps.calls.migrate, 0);

  const failureDeps = mockDeps({
    migrate: async () => {
      throw new Error(`Shopify error leaked ${LEGACY_TOKEN}`);
    },
  });
  const failure = await runAuth2bCanaryExchange(failureDeps, { execute: true });
  assert.equal(failure.type, "auth2b_canary_exchange_failed");
  assert.ok(!JSON.stringify(failure).includes(LEGACY_TOKEN));

  const storeFailureDeps = mockDeps({ store: async () => false });
  const storeFailure = await runAuth2bCanaryExchange(storeFailureDeps, {
    execute: true,
  });
  assert.equal(storeFailure.type, "auth2b_canary_store_failed_after_exchange");
  assert.equal(storeFailure.stored, false);

  const lockedDeps = mockDeps({ acquireLock: async () => false });
  const locked = await runAuth2bCanaryExchange(lockedDeps, { execute: true });
  assert.equal(locked.error, "exchange_already_locked");
  assert.equal(lockedDeps.calls.migrate, 0);

  const downgrade = await runAuth2bCanaryExchange(
    mockDeps({ inspectedRow: row({ tokenCiphertext: "ciphertext" }) }),
  );
  assert.equal(
    downgrade.error,
    "session_is_not_generation_zero_legacy_offline",
  );

  const mismatch = await runAuth2bCanaryExchange(
    mockDeps({ inspectedRow: row({ shop: "luckywifi-0.myshopify.com" }) }),
  );
  assert.equal(mismatch.error, "fixed_target_mismatch");

  const concurrentDeps = mockDeps({
    migrate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { session: expiringSession() };
    },
  });
  const [first, second] = await Promise.all([
    runAuth2bCanaryExchange(concurrentDeps, { execute: true }),
    runAuth2bCanaryExchange(concurrentDeps, { execute: true }),
  ]);
  assert.ok([first.type, second.type].includes("auth2b_canary_rejected"));
  assert.equal(concurrentDeps.calls.migrate, 1);

  const routeSource = readFileSync(
    join(webRoot, "app/routes/api.auth2b-canary-exchange.ts"),
    "utf8",
  );
  assert.ok(!routeSource.includes("requestBody"));
  assert.ok(!routeSource.includes("shop_id"));
  assert.ok(routeSource.includes("AUTH2B_OPERATOR_CONFIRMATION"));

  const allOutput = JSON.stringify({
    dry,
    success,
    rerun,
    failure,
    storeFailure,
  });
  assert.ok(!allOutput.includes(LEGACY_TOKEN));
  assert.ok(!allOutput.includes(REFRESH_TOKEN));
}

async function main() {
  await testLocalCustomSessionStorage();
  await testMockSafetyCases();
  console.log(
    JSON.stringify({
      type: "auth2b_canary_tests_ok",
      checks: [
        "fixed_shop",
        "dry_run_default",
        "official_migration_adapter",
        "custom_session_storage",
        "success",
        "exchange_failure_redaction",
        "store_failure_boundary",
        "rerun_rejected",
        "concurrent_run_rejected",
        "legacy_only_preflight",
        "downgrade_rejected",
        "luckywifi_isolation",
        "route_does_not_accept_shop_input",
      ],
    }),
  );
}

main().catch((error) => {
  // Keep diagnostics token-safe; never print the raw exception body.
  const message = error instanceof Error ? error.message : "unknown";
  console.error(
    JSON.stringify({
      type: "auth2b_canary_tests_failed",
      error_name: error instanceof Error ? error.name : "unknown",
      error: message.replace(/shpat_[^\s'"`]+|shprt_[^\s'"`]+/gi, "<redacted>"),
      stack:
        error instanceof Error
          ? error.stack?.split("\n").slice(0, 4)
          : undefined,
    }),
  );
  process.exit(1);
});
