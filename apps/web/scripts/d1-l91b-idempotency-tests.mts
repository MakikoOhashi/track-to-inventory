/**
 * Stage L9.1b: deterministic item IDs + backfill idempotency tests (local D1).
 *
 * Run: npm run test:d1:l91b
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import { D1_MIGRATION_VERSION, nowIso } from "../app/lib/d1/client.server.ts";
import {
  buildDeterministicItemId,
  fingerprintD1ItemRows,
  parseItemQuantity,
  ShipmentItemValidationError,
  supabaseItemsToD1Rows,
} from "../app/lib/d1/shipmentItemsCompat.server.ts";
import {
  createShipmentsRepository,
} from "../app/lib/d1/shipments.server.ts";
import {
  withBackfillUpsert,
  type SupabaseShipmentRow,
} from "../app/lib/d1/shipmentsBackfill.server.ts";

const SHOP = "l91b-alpha.myshopify.com";
const SHIPMENT_ID = "e4f866c5-a576-4bbd-9088-d8b0ab75cd3f";
const NOW = "2026-07-26T12:00:00.000Z";

async function reset(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM shipment_items"),
    db.prepare("DELETE FROM shipments"),
    db.prepare("DELETE FROM shops WHERE shop_id LIKE 'l91b-%'"),
  ]);
}

function sampleRow(overrides: Partial<SupabaseShipmentRow> = {}): SupabaseShipmentRow {
  return {
    id: SHIPMENT_ID,
    shop_id: SHOP,
    si_number: "SI-L91B-001",
    status: "SI発行済",
    supplier_name: "ABC Trading Inc.",
    transport_type: "KAIYOU MARU",
    memo: null,
    etd: null,
    eta: null,
    clearance_date: null,
    arrival_date: null,
    delayed: false,
    is_archived: false,
    invoice_url: null,
    pl_url: null,
    si_url: null,
    other_url: null,
    items: [
      { sync_item_id: "line-sync", name: "Synced", quantity: 10, variant_id: "gid://v/1" },
      { name: "Plain A", quantity: 100, unit_price: "@16.84", product_code: null },
      { name: "Plain A", quantity: 100, unit_price: "@16.84", product_code: null },
    ],
    ...overrides,
  };
}

async function loadItemFingerprints(db: D1Database, shipmentId: string) {
  const rows = await db
    .prepare(
      `SELECT id, shipment_id, shop_id, si_number, name, product_code, quantity,
              unit_price, variant_id, sort_order, migration_source, migration_version,
              created_at, updated_at
       FROM shipment_items WHERE shipment_id = ? ORDER BY sort_order`,
    )
    .bind(shipmentId)
    .all<Record<string, unknown>>();
  return fingerprintD1ItemRows(
    (rows.results ?? []).map((r) => ({
      id: String(r.id),
      shipment_id: String(r.shipment_id),
      shop_id: String(r.shop_id),
      si_number: String(r.si_number),
      name: r.name == null ? null : String(r.name),
      product_code: r.product_code == null ? null : String(r.product_code),
      quantity: r.quantity == null ? null : Number(r.quantity),
      unit_price: r.unit_price == null ? null : String(r.unit_price),
      variant_id: r.variant_id == null ? null : String(r.variant_id),
      sort_order: Number(r.sort_order),
      migration_source: null,
      migration_version: null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    })),
  );
}

async function main() {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    const repo = withBackfillUpsert(createShipmentsRepository(db));
    await reset(db);

    const row = sampleRow();

    // Double conversion → identical fingerprints
    const convert = () =>
      supabaseItemsToD1Rows({
        items: row.items,
        shipmentId: SHIPMENT_ID,
        shopId: SHOP,
        siNumber: row.si_number,
        now: NOW,
        migrationVersion: D1_MIGRATION_VERSION,
        parseOptions: { strictUnknownKeys: true },
      });
    const a = convert();
    const b = convert();
    assert.deepEqual(fingerprintD1ItemRows(a), fingerprintD1ItemRows(b));
    assert.equal(a[0]?.id, "line-sync");
    assert.notEqual(a[1]?.id, a[2]?.id, "duplicate business fields at different indices differ");

    // Reorder changes deterministic ids (index is part of material)
    const reordered = supabaseItemsToD1Rows({
      items: [row.items![1], row.items![0], row.items![2]],
      shipmentId: SHIPMENT_ID,
      shopId: SHOP,
      siNumber: row.si_number,
      now: NOW,
      migrationVersion: D1_MIGRATION_VERSION,
    });
    assert.notEqual(reordered[0]?.id, a[1]?.id);
    assert.equal(reordered[1]?.id, "line-sync");

    // Invalid quantity rejected
    assert.throws(
      () => parseItemQuantity("not-a-number", 0),
      (e: unknown) => e instanceof ShipmentItemValidationError && e.code === "INVALID_QUANTITY",
    );

    // Unknown keys rejected in strict mode
    assert.throws(
      () =>
        supabaseItemsToD1Rows({
          items: [{ name: "X", quantity: 1, extra_field: "nope" } as never],
          shipmentId: SHIPMENT_ID,
          shopId: SHOP,
          siNumber: row.si_number,
          now: NOW,
          migrationVersion: D1_MIGRATION_VERSION,
          parseOptions: { strictUnknownKeys: true },
        }),
      (e: unknown) => e instanceof ShipmentItemValidationError && e.code === "UNKNOWN_ITEM_KEYS",
    );

    // Backfill twice → same item ids, no row growth
    const first = await repo.upsertFromSupabaseBackfill(row);
    assert.equal(first.action, "inserted");
    const fp1 = await loadItemFingerprints(db, SHIPMENT_ID);
    const count1 = await db
      .prepare("SELECT COUNT(*) AS c FROM shipment_items WHERE shipment_id = ?")
      .bind(SHIPMENT_ID)
      .first<{ c: number }>();

    const second = await repo.upsertFromSupabaseBackfill(row);
    assert.equal(second.action, "updated");
    const fp2 = await loadItemFingerprints(db, SHIPMENT_ID);
    const count2 = await db
      .prepare("SELECT COUNT(*) AS c FROM shipment_items WHERE shipment_id = ?")
      .bind(SHIPMENT_ID)
      .first<{ c: number }>();

    assert.deepEqual(fp1, fp2);
    assert.equal(Number(count1?.c), Number(count2?.c));
    assert.equal(Number(count2?.c), 3);

    // create path uses same deterministic rule (non-strict unknown keys)
    await reset(db);
    const created = await repo.create(SHOP, {
      id: randomUUID(),
      si_number: "SI-CREATE",
      items: [{ name: "Only", quantity: 5 }],
    });
    const expectedDet = buildDeterministicItemId(
      {
        shipmentId: created.id,
        shopId: SHOP,
        siNumber: "SI-CREATE",
        index: 0,
      },
      {
        name: "Only",
        product_code: null,
        quantity: 5,
        unit_price: null,
        variant_id: null,
      },
    );
    assert.equal(created.items[0]?.sync_item_id, expectedDet);

    await reset(db);

    console.log(
      JSON.stringify({
        type: "d1_l91b_idempotency_ok",
        checks: [
          "double_conversion_identical",
          "sync_item_id_preserved",
          "duplicate_items_distinct_ids",
          "reorder_changes_deterministic_ids",
          "invalid_quantity_rejected",
          "unknown_keys_rejected_strict",
          "backfill_twice_no_drift",
          "create_uses_same_deterministic_rule",
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
