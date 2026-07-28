/** AUTH-REINSTALL-1 local-only uninstall/reinstall contract test. */
import assert from "node:assert/strict";
import { Session } from "@shopify/shopify-api";
import { getPlatformProxy } from "wrangler";
import { cleanupUninstall } from "../app/lib/uninstallCleanup.server.ts";
import { createShopifySessionRepository } from "../app/lib/d1/shopifySessions.server.ts";

process.env.TOKEN_ENCRYPTION_KEY ??= "auth1b-local-test-key-32-bytes!!";
process.env.SHOPIFY_API_KEY ??= "auth-reinstall-local-key";
process.env.SHOPIFY_API_SECRET ??= "auth-reinstall-local-secret";
process.env.SCOPES ??= "read_products";
process.env.SHOPIFY_APP_URL ??= "https://auth-reinstall.local";

const SHOP = "auth-reinstall-test.myshopify.com";
const SESSION_ID = `offline_${SHOP}`;
const SHIPMENT_ID = "auth-reinstall-shipment";
const ITEM_ID = "auth-reinstall-item";
const NOW = "2026-01-01T00:00:00.000Z";

function legacySession() {
  return new Session({
    id: SESSION_ID,
    shop: SHOP,
    state: "legacy",
    isOnline: false,
    accessToken: "shpat_auth_reinstall_legacy_test_only",
    scope: "read_products",
  });
}

function expiringSession() {
  return new Session({
    id: SESSION_ID,
    shop: SHOP,
    state: "",
    isOnline: false,
    accessToken: "shpat_auth_reinstall_new_test_only",
    refreshToken: "auth_reinstall_refresh_test_only",
    expires: new Date("2026-01-01T01:00:00.000Z"),
    refreshTokenExpires: new Date("2026-04-01T00:00:00.000Z"),
    scope: "read_products",
  });
}

async function main() {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await db.batch([
      db.prepare("DELETE FROM shipment_items WHERE shop_id = ?").bind(SHOP),
      db.prepare("DELETE FROM file_objects WHERE shop_id = ?").bind(SHOP),
      db
        .prepare("DELETE FROM inventory_sync_ledger WHERE shop_id = ?")
        .bind(SHOP),
      db.prepare("DELETE FROM shipments WHERE shop_id = ?").bind(SHOP),
      db.prepare("DELETE FROM shops WHERE shop_id = ?").bind(SHOP),
      db.prepare("DELETE FROM shopify_sessions WHERE shop = ?").bind(SHOP),
    ]);

    await db
      .prepare(
        `INSERT INTO shops (shop_id, installed_at, migration_source, migration_version, created_at, updated_at)
         VALUES (?, ?, 'test', 'auth-reinstall-1', ?, ?)`,
      )
      .bind(SHOP, NOW, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO shipments (
           id, shop_id, si_number, status, supplier_name, created_at, updated_at
         ) VALUES (?, ?, 'AUTH-REINSTALL', 'SI Issued', 'test', ?, ?)`,
      )
      .bind(SHIPMENT_ID, SHOP, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO shipment_items (
           id, shipment_id, shop_id, si_number, name, quantity, sort_order,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'AUTH-REINSTALL', 'Preserved item', 2, 0, ?, ?)`,
      )
      .bind(ITEM_ID, SHIPMENT_ID, SHOP, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO inventory_sync_ledger (
           id, shop_id, si_number, item_key, idempotency_key, variant_id,
           delta_quantity, status, created_at, updated_at
         ) VALUES ('auth-reinstall-ledger', ?, 'AUTH-REINSTALL', 'item',
                   'auth-reinstall-operation', 'variant', 1, 'succeeded', ?, ?)`,
      )
      .bind(SHOP, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO file_objects (
           id, shop_id, shipment_id, si_number, kind, r2_key,
           created_at, updated_at
         ) VALUES ('auth-reinstall-file', ?, ?, 'AUTH-REINSTALL', 'si',
                   'shops/auth-reinstall/si.pdf', ?, ?)`,
      )
      .bind(SHOP, SHIPMENT_ID, NOW, NOW)
      .run();

    const repository = createShopifySessionRepository(db);
    const legacy = legacySession();
    await db
      .prepare(
        `INSERT INTO shopify_sessions (
           id, shop, payload_json, is_online, expires_at,
           migration_source, migration_version, created_at, updated_at
         ) VALUES (?, ?, ?, 0, NULL, 'legacy-test', 'l1-v1', ?, ?)`,
      )
      .bind(
        legacy.id,
        legacy.shop,
        JSON.stringify({ entries: legacy.toPropertyArray(true), shop: SHOP }),
        NOW,
        NOW,
      )
      .run();
    const before = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM shipments WHERE shop_id = ?) AS shipments,
           (SELECT COUNT(*) FROM shipment_items WHERE shop_id = ?) AS items,
           (SELECT COUNT(*) FROM inventory_sync_ledger WHERE shop_id = ?) AS ledger,
           (SELECT COUNT(*) FROM file_objects WHERE shop_id = ?) AS files,
           (SELECT status FROM shipments WHERE id = ?) AS shipment_status,
           (SELECT supplier_name FROM shipments WHERE id = ?) AS shipment_supplier`,
      )
      .bind(SHOP, SHOP, SHOP, SHOP, SHIPMENT_ID, SHIPMENT_ID)
      .first<Record<string, unknown>>();

    await cleanupUninstall(SHOP, {
      findSessionsByShop: (shop) => repository.findSessionsByShop(shop),
      deleteSessions: async (ids) => {
        await Promise.all(
          ids.map((id) => repository.deleteSession(id, { shop: SHOP })),
        );
        return true;
      },
    });

    const tombstone = await db
      .prepare(
        `SELECT migration_source, token_ciphertext, token_expires_at,
                token_fingerprint, token_generation, payload_json
         FROM shopify_sessions WHERE id = ?`,
      )
      .bind(SESSION_ID)
      .first<Record<string, unknown>>();
    assert.equal(tombstone?.migration_source, "deleted");
    assert.equal(tombstone?.token_ciphertext, null);
    assert.equal(tombstone?.token_expires_at, null);
    assert.equal(tombstone?.token_fingerprint, null);
    assert.equal(Number(tombstone?.token_generation), 0);
    assert.ok(!String(tombstone?.payload_json).includes("shpat_"));

    const after = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM shipments WHERE shop_id = ?) AS shipments,
           (SELECT COUNT(*) FROM shipment_items WHERE shop_id = ?) AS items,
           (SELECT COUNT(*) FROM inventory_sync_ledger WHERE shop_id = ?) AS ledger,
           (SELECT COUNT(*) FROM file_objects WHERE shop_id = ?) AS files,
           (SELECT status FROM shipments WHERE id = ?) AS shipment_status,
           (SELECT supplier_name FROM shipments WHERE id = ?) AS shipment_supplier`,
      )
      .bind(SHOP, SHOP, SHOP, SHOP, SHIPMENT_ID, SHIPMENT_ID)
      .first<Record<string, unknown>>();
    assert.deepEqual(after, before);

    assert.equal(await repository.storeSession(expiringSession()), true);
    const reinstalled = await repository.loadSession(SESSION_ID);
    assert.equal(reinstalled?.shop, SHOP);
    assert.equal(reinstalled?.refreshToken, "auth_reinstall_refresh_test_only");
    assert.equal(
      reinstalled?.expires?.toISOString(),
      "2026-01-01T01:00:00.000Z",
    );
    const row = await db
      .prepare(
        `SELECT payload_json, token_ciphertext, token_expires_at,
                token_fingerprint, token_generation
         FROM shopify_sessions WHERE id = ?`,
      )
      .bind(SESSION_ID)
      .first<Record<string, unknown>>();
    assert.ok(row?.token_ciphertext);
    assert.equal(row?.token_expires_at, "2026-01-01T01:00:00.000Z");
    assert.equal(Number(row?.token_generation), 1);
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes("shpat_auth_reinstall_new_test_only"));
    assert.ok(!serialized.includes("auth_reinstall_refresh_test_only"));
    assert.equal(
      Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM shopify_sessions WHERE shop = ?",
            )
            .bind(SHOP)
            .first<{ c: number }>()
        )?.c,
      ),
      1,
    );

    const routeSource = await import("node:fs/promises").then((fs) =>
      fs.readFile("app/routes/webhooks.app.uninstalled.jsx", "utf8"),
    );
    assert.ok(!routeSource.includes("createSupabaseAdminClient"));
    assert.ok(!routeSource.includes("shadowWriteShipmentMirror"));
    assert.ok(!routeSource.includes('operation: "delete_all"'));

    console.log(
      JSON.stringify({
        type: "auth_reinstall_tests_ok",
        checks: [
          "session_tombstone",
          "token_fields_cleared",
          "d1_business_data_preserved",
          "supabase_cleanup_not_called",
          "shadow_delete_all_removed",
          "reinstall_generation_one_encrypted",
          "same_shop_session_reused",
          "no_duplicate_offline_session",
        ],
      }),
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      type: "auth_reinstall_tests_failed",
      error_name: error?.name,
      error_message:
        error instanceof Error
          ? error.message.replace(
              /shpat_[^\s"']+|auth_reinstall_[^\s"']+/gi,
              "<redacted>",
            )
          : "unknown",
    }),
  );
  process.exit(1);
});
