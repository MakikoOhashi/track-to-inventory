/**
 * Local D1 integration tests for Stage L1 repositories.
 * Run: npm run test:d1
 *
 * Uses wrangler getPlatformProxy → local TTI_DB only.
 * Does not touch Redis / Supabase / production D1 remote.
 */
import assert from "node:assert/strict";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import {
  classifyD1Error,
  createInventorySyncLedgerRepository,
  createShopifySessionRepository,
  deserializeSessionPayload,
  D1RepositoryError,
  serializeSessionPayload,
} from "../app/lib/d1/index.server.ts";
import { sessionSecretsFromSession } from "../app/lib/shopifySessionSecrets.server.ts";

process.env.TOKEN_ENCRYPTION_KEY ??= "auth1b-local-test-key-32-bytes!!";

async function resetLedger(db: D1Database) {
  await db.prepare("DELETE FROM inventory_sync_ledger").run();
}

async function resetSessions(db: D1Database) {
  await db.prepare("DELETE FROM shopify_sessions").run();
}

function makeOfflineSession(id: string, shop: string) {
  return new Session({
    id,
    shop,
    state: "state",
    isOnline: false,
    accessToken: "test-token-offline",
    scope: "read_products",
  });
}

function makeOnlineSession(id: string, shop: string, expires: Date) {
  return new Session({
    id,
    shop,
    state: "state",
    isOnline: true,
    accessToken: "test-token-online",
    scope: "read_products",
    expires,
  });
}

async function main() {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    assert.ok(db, "TTI_DB binding missing from platform proxy");

    const ledger = createInventorySyncLedgerRepository(db);
    const sessions = createShopifySessionRepository(db);

    // --- schema constraints ---
    await resetLedger(db);

    await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-1",
      itemKey: "item-1",
      variantId: "gid://shopify/ProductVariant/1",
      deltaQuantity: 2,
      idempotencyKey: "idem-unique-1",
    });

    let dupRejected = false;
    try {
      await db
        .prepare(
          `INSERT INTO inventory_sync_ledger (
             id, shop_id, si_number, item_key, idempotency_key, variant_id,
             delta_quantity, status, attempt_count, created_at, updated_at, row_version
           ) VALUES ('x','shop-b.myshopify.com','SI-2','item-2','idem-unique-1','v',1,'pending',0,?,?,1)`,
        )
        .bind(new Date().toISOString(), new Date().toISOString())
        .run();
    } catch (error) {
      dupRejected = true;
      const classified = classifyD1Error(error);
      assert.equal(classified.classification, "constraint");
      assert.equal(classified.retryable, false);
    }
    assert.ok(dupRejected, "duplicate idempotency_key must be rejected");

    let badStatusRejected = false;
    try {
      await db
        .prepare(
          `INSERT INTO inventory_sync_ledger (
             id, shop_id, si_number, item_key, idempotency_key, variant_id,
             delta_quantity, status, attempt_count, created_at, updated_at, row_version
           ) VALUES ('y','shop-a.myshopify.com','SI-1','item-z','idem-bad-status','v',1,'nope',0,?,?,1)`,
        )
        .bind(new Date().toISOString(), new Date().toISOString())
        .run();
    } catch (error) {
      badStatusRejected = true;
      const classified = classifyD1Error(error);
      assert.ok(
        classified.classification === "check" ||
          classified.classification === "constraint",
      );
    }
    assert.ok(badStatusRejected, "invalid status must be rejected");

    // --- claim CAS ---
    await resetLedger(db);
    const claim1 = await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-1",
      itemKey: "item-1",
      variantId: "gid://shopify/ProductVariant/1",
      deltaQuantity: 3,
      idempotencyKey: "idem-claim-1",
    });
    assert.equal(claim1.action, "claimed");
    assert.ok(claim1.row?.claim_token);

    const claimBusy = await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-1",
      itemKey: "item-1",
      variantId: "gid://shopify/ProductVariant/1",
      deltaQuantity: 3,
      idempotencyKey: "idem-claim-1",
    });
    assert.equal(claimBusy.action, "in_progress");
    // Existing owner token must be preserved (no silent reclaim)
    assert.equal(claimBusy.row?.claim_token, claim1.row?.claim_token);

    // wrong token finalize
    const badFinalize = await ledger.finalizeSucceeded({
      id: claim1.row!.id,
      claimToken: "wrong-token",
      shopifyAdjustmentId: "adj-x",
    });
    assert.equal(badFinalize.ok, false);
    assert.equal(badFinalize.reason, "OWNER_MISMATCH");

    const okFinalize = await ledger.finalizeSucceeded({
      id: claim1.row!.id,
      claimToken: claim1.row!.claim_token!,
      inventoryItemId: "inv-1",
      locationId: "loc-1",
      shopifyAdjustmentId: "adj-1",
    });
    assert.equal(okFinalize.ok, true);
    assert.equal(okFinalize.row?.status, "succeeded");
    assert.equal(okFinalize.row?.claim_token, null);
    assert.ok(okFinalize.row?.succeeded_at);
    assert.ok(okFinalize.row?.completed_at);

    const already = await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-1",
      itemKey: "item-1",
      variantId: "gid://shopify/ProductVariant/1",
      deltaQuantity: 3,
      idempotencyKey: "idem-claim-1",
    });
    assert.equal(already.action, "already_synced");

    const found = await ledger.findByIdempotencyKey("idem-claim-1");
    assert.equal(found?.status, "succeeded");
    const succeeded = await ledger.findSucceeded({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-1",
      itemKey: "item-1",
      idempotencyKey: "idem-claim-1",
    });
    assert.ok(succeeded);

    // stale processing is NOT auto-reclaimed on claim
    await resetLedger(db);
    const staleClaim = await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-2",
      itemKey: "item-2",
      variantId: "v2",
      deltaQuantity: 1,
      idempotencyKey: "idem-stale",
    });
    assert.equal(staleClaim.action, "claimed");
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await db
      .prepare(
        `UPDATE inventory_sync_ledger SET claimed_at = ?, started_at = ? WHERE id = ?`,
      )
      .bind(old, old, staleClaim.row!.id)
      .run();

    const stillBusy = await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-2",
      itemKey: "item-2",
      variantId: "v2",
      deltaQuantity: 1,
      idempotencyKey: "idem-stale",
    });
    assert.equal(stillBusy.action, "in_progress");

    const marked = await ledger.markAmbiguous({
      id: staleClaim.row!.id,
      staleBefore: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    assert.equal(marked.ok, true);
    assert.equal(marked.row?.status, "ambiguous");

    // retryable reclaim path
    await resetLedger(db);
    const c = await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-3",
      itemKey: "item-3",
      variantId: "v3",
      deltaQuantity: 1,
      idempotencyKey: "idem-retry",
    });
    await ledger.finalizeFailure({
      id: c.row!.id,
      claimToken: c.row!.claim_token!,
      status: "failed_retryable",
      errorCode: "TMP",
      errorMessage: "temp",
    });
    const reclaim = await ledger.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-3",
      itemKey: "item-3",
      variantId: "v3",
      deltaQuantity: 1,
      idempotencyKey: "idem-retry",
    });
    assert.equal(reclaim.action, "claimed");
    assert.equal(reclaim.row?.attempt_count, 2);

    // --- sessions ---
    await resetSessions(db);
    const shop = "demo.myshopify.com";
    const offline = makeOfflineSession("offline_demo.myshopify.com", shop);
    const payload = serializeSessionPayload(offline);
    const roundTrip = deserializeSessionPayload(
      payload,
      sessionSecretsFromSession(offline),
    );
    assert.equal(roundTrip.id, offline.id);
    assert.equal(roundTrip.shop, offline.shop);
    assert.equal(roundTrip.accessToken, offline.accessToken);
    assert.equal(roundTrip.isOnline, false);

    assert.equal(await sessions.storeSession(offline), true);
    const loaded = await sessions.loadSession(offline.id);
    assert.ok(loaded);
    assert.equal(loaded!.accessToken, "test-token-offline");

    const expired = makeOnlineSession(
      "online_expired",
      shop,
      new Date(Date.now() - 60_000),
    );
    await sessions.storeSession(expired);
    assert.equal(await sessions.loadSession("online_expired"), undefined);

    const activeOnline = makeOnlineSession(
      "online_active",
      shop,
      new Date(Date.now() + 3_600_000),
    );
    await sessions.storeSession(activeOnline);

    const byShop = await sessions.findSessionsByShop(shop);
    assert.ok(byShop.some((s) => s.id === offline.id));
    assert.ok(byShop.some((s) => s.id === "online_active"));
    assert.ok(!byShop.some((s) => s.id === "online_expired"));

    await sessions.deleteSession(offline.id);
    assert.equal(await sessions.loadSession(offline.id), undefined);

    // error classification helper
    const fake = classifyD1Error(
      new Error("D1_ERROR: UNIQUE constraint failed"),
    );
    assert.ok(fake instanceof D1RepositoryError);
    assert.equal(fake.classification, "constraint");
    assert.equal(fake.retryable, false);

    // cleanup test rows so local DB stays near-empty
    await resetLedger(db);
    await resetSessions(db);

    console.log(
      JSON.stringify({
        type: "d1_l1_integration_ok",
        checks: [
          "idempotency_unique",
          "status_check",
          "claim_cas",
          "finalize_owner_mismatch",
          "already_synced",
          "stale_no_reclaim",
          "mark_ambiguous",
          "retryable_reclaim",
          "session_serialize",
          "session_expiry",
          "session_by_shop",
          "error_classification",
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
