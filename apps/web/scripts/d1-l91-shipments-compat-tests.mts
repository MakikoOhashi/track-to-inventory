/**
 * Stage L9.1: Shipments D1 repository Supabase compatibility tests (local D1 only).
 *
 * Run: npm run test:d1:l91
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import {
  createShipmentsRepository,
  normalizeShipmentForCompare,
  ShipmentDuplicateError,
  type SupabaseCompatibleShipment,
} from "../app/lib/d1/shipments.server.ts";
import type { ShipmentLineItem } from "../app/lib/syncItemIdentity.server.ts";

const SHOP_A = "l91-alpha.myshopify.com";
const SHOP_B = "l91-beta.myshopify.com";

function supabaseFixture(overrides: Partial<SupabaseCompatibleShipment> = {}): Omit<
  SupabaseCompatibleShipment,
  "id"
> & { id?: string } {
  return {
    id: overrides.id,
    shop_id: SHOP_A,
    si_number: "SI-L91-001",
    status: "SI発行済",
    supplier_name: "ABC Trading Inc.",
    transport_type: "KAIYOU MARU",
    memo: "test memo",
    etd: "2026-08-01",
    eta: "2026-08-15",
    clearance_date: null,
    arrival_date: null,
    delayed: false,
    is_archived: false,
    invoice_url: null,
    pl_url: null,
    si_url: null,
    other_url: null,
    items: [
      {
        sync_item_id: "line-a",
        name: "Widget A",
        quantity: 100,
        unit_price: "@16.84",
        product_code: "W-A",
        variant_id: "gid://shopify/ProductVariant/111",
      },
      {
        sync_item_id: "line-b",
        name: "Widget B",
        quantity: 50,
        unit_price: "@8.39",
        product_code: null,
        variant_id: "gid://shopify/ProductVariant/222",
      },
    ],
    ...overrides,
  };
}

async function resetShipments(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM shipment_items"),
    db.prepare("DELETE FROM shipments"),
    db.prepare("DELETE FROM shops WHERE shop_id LIKE 'l91-%'"),
  ]);
}

function compareRoundTrip(
  input: Omit<SupabaseCompatibleShipment, "id"> & { id?: string },
  output: SupabaseCompatibleShipment,
) {
  const expected = normalizeShipmentForCompare({
    ...input,
    id: output.id,
    shop_id: SHOP_A,
    items: input.items ?? [],
  } as SupabaseCompatibleShipment);
  const actual = normalizeShipmentForCompare(output);
  assert.deepEqual(
    {
      ...actual,
      id: undefined,
    },
    {
      ...expected,
      id: undefined,
    },
  );
}

async function main() {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    assert.ok(db, "TTI_DB binding missing");
    const repo = createShipmentsRepository(db);
    await resetShipments(db);

    const shipmentSql = await db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='shipments'",
      )
      .first<{ sql: string }>();
    assert.ok(shipmentSql?.sql?.includes("invoice_url"), "invoice_url column");
    assert.ok(shipmentSql?.sql?.includes("other_url"), "other_url column");

    // Round-trip full fixture
    const fixture = supabaseFixture({ id: randomUUID() });
    const created = await repo.create(SHOP_A, {
      id: fixture.id,
      si_number: fixture.si_number,
      status: fixture.status,
      supplier_name: fixture.supplier_name,
      transport_type: fixture.transport_type,
      memo: fixture.memo,
      etd: fixture.etd,
      eta: fixture.eta,
      clearance_date: fixture.clearance_date,
      arrival_date: fixture.arrival_date,
      delayed: fixture.delayed,
      is_archived: fixture.is_archived,
      invoice_url: fixture.invoice_url,
      pl_url: fixture.pl_url,
      si_url: fixture.si_url,
      other_url: fixture.other_url,
      items: fixture.items,
    });
    compareRoundTrip(fixture, created);

    const byId = await repo.getById(SHOP_A, created.id);
    assert.ok(byId);
    compareRoundTrip(fixture, byId);

    const bySi = await repo.getByShopAndSi(SHOP_A, fixture.si_number);
    assert.ok(bySi);
    compareRoundTrip(fixture, bySi);

    // Items without sync_item_id get deterministic ids on read-back
    const noSync = supabaseFixture({
      si_number: "SI-NO-SYNC",
      items: [{ name: "Plain", quantity: 3, unit_price: "@1.00" }],
    });
    const createdNoSync = await repo.create(SHOP_A, {
      id: randomUUID(),
      si_number: noSync.si_number,
      items: noSync.items,
    });
    assert.equal(createdNoSync.items.length, 1);
    const id1 = createdNoSync.items[0]?.sync_item_id;
    assert.ok(id1);
    const reloaded = await repo.getByShopAndSi(SHOP_A, noSync.si_number);
    assert.equal(reloaded?.items[0]?.sync_item_id, id1);

    // CRUD list + delete
    assert.equal(await repo.countByShop(SHOP_A), 2);
    const list = await repo.listByShop(SHOP_A);
    assert.equal(list.length, 2);

    assert.equal(await repo.delete(SHOP_A, "SI-NO-SYNC"), true);
    assert.equal(await repo.countByShop(SHOP_A), 1);

    // Partial update preserves untouched fields
    const partial = await repo.update(SHOP_A, fixture.si_number, {
      memo: "updated memo",
      eta: "",
      status: "通関中",
    });
    assert.ok(partial);
    assert.equal(partial.memo, "updated memo");
    assert.equal(partial.eta, null);
    assert.equal(partial.status, "通関中");
    assert.equal(partial.supplier_name, fixture.supplier_name);
    assert.equal(partial.items.length, fixture.items.length);

    // Items replace: add / change / delete
    const newItems: ShipmentLineItem[] = [
      {
        sync_item_id: "line-a",
        name: "Widget A revised",
        quantity: 120,
        variant_id: "gid://shopify/ProductVariant/111",
      },
      {
        sync_item_id: "line-c",
        name: "Widget C",
        quantity: 10,
        variant_id: "gid://shopify/ProductVariant/333",
      },
    ];
    const itemsUpdated = await repo.update(SHOP_A, fixture.si_number, {
      items: newItems,
    });
    assert.ok(itemsUpdated);
    assert.equal(itemsUpdated.items.length, 2);
    assert.equal(itemsUpdated.items[0]?.name, "Widget A revised");
    assert.equal(itemsUpdated.items[0]?.quantity, 120);
    assert.equal(itemsUpdated.items[1]?.sync_item_id, "line-c");

    const cleared = await repo.update(SHOP_A, fixture.si_number, { items: [] });
    assert.ok(cleared);
    assert.deepEqual(cleared.items, []);

    // Restore items for downstream tests
    await repo.update(SHOP_A, fixture.si_number, { items: fixture.items });

    // Shop boundary
    await repo.create(SHOP_B, { si_number: "SI-B-1", items: [] });
    assert.equal(await repo.getByShopAndSi(SHOP_B, fixture.si_number), undefined);
    assert.equal(await repo.getById(SHOP_B, created.id), undefined);
    assert.equal(await repo.update(SHOP_B, fixture.si_number, { memo: "hack" }), undefined);
    assert.equal(await repo.delete(SHOP_B, fixture.si_number), false);

    // UNIQUE (shop_id, si_number)
    await assert.rejects(
      () => repo.create(SHOP_A, { si_number: fixture.si_number, items: [] }),
      (err: unknown) => err instanceof ShipmentDuplicateError,
    );

    // deleteAllByShop
    assert.ok((await repo.countByShop(SHOP_A)) >= 1);
    assert.ok((await repo.countByShop(SHOP_B)) >= 1);
    const removedA = await repo.deleteAllByShop(SHOP_A);
    assert.ok(removedA >= 1);
    assert.equal(await repo.countByShop(SHOP_A), 0);
    assert.ok((await repo.countByShop(SHOP_B)) >= 1);

    await resetShipments(db);

    console.log(
      JSON.stringify({
        type: "d1_l91_shipments_compat_ok",
        checks: [
          "schema_file_url_columns",
          "round_trip_full_fixture",
          "get_by_id_and_si",
          "items_without_sync_item_id",
          "crud_list_delete",
          "partial_update",
          "items_replace_add_change_delete",
          "shop_boundary",
          "unique_shop_si",
          "count_by_shop",
          "delete_all_by_shop",
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
