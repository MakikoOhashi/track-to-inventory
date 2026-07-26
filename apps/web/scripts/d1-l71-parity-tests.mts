/**
 * Stage L7.1: D1 inventory_sync_ledger parity vs Supabase claim RPC semantics.
 * Local D1 only — no Shopify, Redis, or production inventory mutation.
 *
 * Run: npm run test:d1:l71
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import { createInventorySyncLedgerRepository } from "../app/lib/d1/inventorySyncLedger.server.ts";
import type { InventorySyncLedgerListRow } from "../app/lib/d1/inventorySyncLedger.server.ts";
import type { LedgerClaimAction } from "../app/lib/d1/types.server.ts";

const SHOP = "l71-parity.myshopify.com";
const SI = "SI-L71";

type ClaimParams = {
  shopId: string;
  siNumber: string;
  itemKey: string;
  variantId: string;
  deltaQuantity: number;
  idempotencyKey: string;
};

function claimParams(overrides: Partial<ClaimParams> & { idempotencyKey: string; itemKey?: string }): ClaimParams {
  return {
    shopId: SHOP,
    siNumber: SI,
    itemKey: overrides.itemKey ?? `item-${overrides.idempotencyKey.slice(0, 8)}`,
    variantId: "gid://shopify/ProductVariant/1",
    deltaQuantity: 1,
    ...overrides,
  };
}

async function resetLedger(db: D1Database) {
  await db.prepare("DELETE FROM inventory_sync_ledger").run();
}

async function seedRow(
  db: D1Database,
  row: {
    id: string;
    status: string;
    itemKey: string;
    idempotencyKey: string;
    attemptCount?: number;
    createdAt: string;
    claimToken?: string | null;
    claimedAt?: string | null;
    startedAt?: string | null;
  },
) {
  const ts = row.createdAt;
  await db
    .prepare(
      `INSERT INTO inventory_sync_ledger (
         id, shop_id, si_number, item_key, idempotency_key, variant_id,
         delta_quantity, status, attempt_count, claim_token, claimed_at, started_at,
         created_at, updated_at, migration_source, migration_version, row_version
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'test', 'l71', 1)`,
    )
    .bind(
      row.id,
      SHOP,
      SI,
      row.itemKey,
      row.idempotencyKey,
      "gid://v/1",
      row.status,
      row.attemptCount ?? 1,
      row.claimToken ?? null,
      row.claimedAt ?? null,
      row.startedAt ?? null,
      ts,
      ts,
    )
    .run();
}

function supabaseEquivalentAction(status: string, reclaimWon: boolean): LedgerClaimAction {
  switch (status) {
    case "succeeded":
      return "already_synced";
    case "processing":
      return reclaimWon ? "claimed" : "in_progress";
    case "ambiguous":
      return "manual_review";
    case "failed_terminal":
      return "terminal";
    case "pending":
    case "failed_retryable":
      return reclaimWon ? "claimed" : "in_progress";
    default:
      return "error";
  }
}

function listFingerprint(rows: InventorySyncLedgerListRow[]): string[] {
  return rows.map(
    (r) =>
      `${r.item_key}|${r.idempotency_key}|${r.status}|${r.attempt_count}|${r.delta_quantity}`,
  );
}

async function main() {
  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    const repo = createInventorySyncLedgerRepository(db);
    await resetLedger(db);

    const statusMatrix: Array<{
      status: string;
      expected: LedgerClaimAction;
      setup?: (db: D1Database) => Promise<void>;
    }> = [
      { status: "succeeded", expected: "already_synced" },
      { status: "processing", expected: "in_progress" },
      { status: "ambiguous", expected: "manual_review" },
      { status: "failed_terminal", expected: "terminal" },
      { status: "failed_retryable", expected: "claimed" },
      { status: "pending", expected: "claimed" },
    ];

    for (const { status, expected } of statusMatrix) {
      await resetLedger(db);
      const idem = `idem-status-${status}`;
      const itemKey = `item-${status}`;
      if (status === "succeeded") {
        const now = new Date().toISOString();
        await seedRow(db, {
          id: randomUUID(),
          status,
          itemKey,
          idempotencyKey: idem,
          createdAt: now,
        });
        await db
          .prepare(
            `UPDATE inventory_sync_ledger SET completed_at = ?, succeeded_at = ? WHERE idempotency_key = ?`,
          )
          .bind(now, now, idem)
          .run();
      } else if (status === "processing") {
        const now = new Date().toISOString();
        await seedRow(db, {
          id: randomUUID(),
          status,
          itemKey,
          idempotencyKey: idem,
          createdAt: now,
          claimToken: randomUUID(),
          claimedAt: now,
          startedAt: now,
        });
      } else {
        const now = new Date().toISOString();
        await seedRow(db, {
          id: randomUUID(),
          status,
          itemKey,
          idempotencyKey: idem,
          createdAt: now,
        });
      }

      const result = await repo.claim(claimParams({ idempotencyKey: idem, itemKey }));
      assert.equal(
        result.action,
        expected,
        `status=${status} expected ${expected}, got ${result.action}`,
      );
      assert.equal(
        result.action,
        supabaseEquivalentAction(status, status === "failed_retryable" || status === "pending"),
        `Supabase parity for status=${status}`,
      );
    }

    // Concurrent claim: exactly one claimed
    await resetLedger(db);
    const concurrentIdem = "idem-concurrent-1";
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, () =>
        repo.claim(claimParams({ idempotencyKey: concurrentIdem, itemKey: "item-conc" })),
      ),
    );
    const claimedCount = concurrent.filter((r) => r.action === "claimed").length;
    const inProgressCount = concurrent.filter((r) => r.action === "in_progress").length;
    assert.equal(claimedCount, 1, "exactly one concurrent claim wins");
    assert.equal(inProgressCount, 11, "losers see in_progress");
    const rowCount = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM inventory_sync_ledger WHERE idempotency_key = ?`,
      )
      .bind(concurrentIdem)
      .first<{ c: number }>();
    assert.equal(Number(rowCount?.c), 1, "single row for idempotency key");

    // Reclaim conflict on failed_retryable: one claimed, rest in_progress
    await resetLedger(db);
    const retryIdem = "idem-retry-race";
    const first = await repo.claim(
      claimParams({ idempotencyKey: retryIdem, itemKey: "item-retry" }),
    );
    assert.equal(first.action, "claimed");
    await repo.finalizeFailure({
      id: first.row!.id,
      claimToken: first.row!.claim_token!,
      status: "failed_retryable",
      errorCode: "TMP",
      errorMessage: "retry me",
    });
    const reclaimRace = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.claim(claimParams({ idempotencyKey: retryIdem, itemKey: "item-retry" })),
      ),
    );
    assert.equal(
      reclaimRace.filter((r) => r.action === "claimed").length,
      1,
      "reclaim race: one claimed",
    );
    assert.equal(
      reclaimRace.filter((r) => r.action === "in_progress").length,
      7,
      "reclaim race: rest in_progress (not error)",
    );
    const afterRetry = await repo.findByIdempotencyKey(retryIdem);
    assert.equal(afterRetry?.status, "processing");
    assert.equal(afterRetry?.attempt_count, 2);

    // claim_token mismatch finalize
    await resetLedger(db);
    const ownIdem = "idem-owner-mismatch";
    const owned = await repo.claim(
      claimParams({ idempotencyKey: ownIdem, itemKey: "item-own" }),
    );
    const badFin = await repo.finalizeSucceeded({
      id: owned.row!.id,
      claimToken: "wrong-token",
      shopifyAdjustmentId: "adj-x",
    });
    assert.equal(badFin.ok, false);
    assert.equal(badFin.reason, "OWNER_MISMATCH");
    const stillProcessing = await repo.findByIdempotencyKey(ownIdem);
    assert.equal(stillProcessing?.status, "processing");

    // stale processing → ambiguous (no auto reclaim on claim)
    await resetLedger(db);
    const staleIdem = "idem-stale";
    const staleClaim = await repo.claim(
      claimParams({ idempotencyKey: staleIdem, itemKey: "item-stale" }),
    );
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await db
      .prepare(
        `UPDATE inventory_sync_ledger SET claimed_at = ?, started_at = ? WHERE id = ?`,
      )
      .bind(old, old, staleClaim.row!.id)
      .run();
    const busy = await repo.claim(
      claimParams({ idempotencyKey: staleIdem, itemKey: "item-stale" }),
    );
    assert.equal(busy.action, "in_progress");
    const marked = await repo.markAmbiguous({
      id: staleClaim.row!.id,
      staleBefore: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    assert.equal(marked.ok, true);
    assert.equal(marked.row?.status, "ambiguous");
    const manual = await repo.claim(
      claimParams({ idempotencyKey: staleIdem, itemKey: "item-stale" }),
    );
    assert.equal(manual.action, "manual_review");

    // success then re-claim → already_synced
    await resetLedger(db);
    const doneIdem = "idem-done";
    const c = await repo.claim(
      claimParams({ idempotencyKey: doneIdem, itemKey: "item-done" }),
    );
    await repo.finalizeSucceeded({
      id: c.row!.id,
      claimToken: c.row!.claim_token!,
      shopifyAdjustmentId: "adj-final",
    });
    const again = await repo.claim(
      claimParams({ idempotencyKey: doneIdem, itemKey: "item-done" }),
    );
    assert.equal(again.action, "already_synced");

    // listForShipment: order, fields, status vs Supabase-shaped expectation
    await resetLedger(db);
    const t1 = "2026-07-26T00:00:01.000Z";
    const t2 = "2026-07-26T00:00:02.000Z";
    const t3 = "2026-07-26T00:00:03.000Z";
    await seedRow(db, {
      id: "row-a",
      status: "succeeded",
      itemKey: "item-a",
      idempotencyKey: "idem-list-a",
      createdAt: t1,
    });
    await db
      .prepare(
        `UPDATE inventory_sync_ledger SET completed_at = ?, shopify_adjustment_id = 'adj-a' WHERE id = 'row-a'`,
      )
      .bind(t1)
      .run();
    await seedRow(db, {
      id: "row-b",
      status: "ambiguous",
      itemKey: "item-b",
      idempotencyKey: "idem-list-b",
      createdAt: t2,
    });
    await db
      .prepare(
        `UPDATE inventory_sync_ledger SET error_code = 'STALE', error_message = 'review' WHERE id = 'row-b'`,
      )
      .run();
    await seedRow(db, {
      id: "row-c",
      status: "failed_terminal",
      itemKey: "item-c",
      idempotencyKey: "idem-list-c",
      createdAt: t3,
    });

    const d1List = await repo.listForShipment({ shopId: SHOP, siNumber: SI });
    const expectedList: InventorySyncLedgerListRow[] = [
      {
        shop_id: SHOP,
        si_number: SI,
        item_key: "item-a",
        variant_id: "gid://v/1",
        delta_quantity: 1,
        status: "succeeded",
        attempt_count: 1,
        started_at: null,
        completed_at: t1,
        shopify_adjustment_id: "adj-a",
        error_code: null,
        error_message: null,
        idempotency_key: "idem-list-a",
      },
      {
        shop_id: SHOP,
        si_number: SI,
        item_key: "item-b",
        variant_id: "gid://v/1",
        delta_quantity: 1,
        status: "ambiguous",
        attempt_count: 1,
        started_at: null,
        completed_at: null,
        shopify_adjustment_id: null,
        error_code: "STALE",
        error_message: "review",
        idempotency_key: "idem-list-b",
      },
      {
        shop_id: SHOP,
        si_number: SI,
        item_key: "item-c",
        variant_id: "gid://v/1",
        delta_quantity: 1,
        status: "failed_terminal",
        attempt_count: 1,
        started_at: null,
        completed_at: null,
        shopify_adjustment_id: null,
        error_code: null,
        error_message: null,
        idempotency_key: "idem-list-c",
      },
    ];

    assert.deepEqual(listFingerprint(d1List), listFingerprint(expectedList));
    assert.equal(d1List.length, 3);
    assert.equal(d1List[0]?.item_key, "item-a");
    assert.equal(d1List[1]?.status, "ambiguous");
    assert.equal(d1List[2]?.status, "failed_terminal");

    await resetLedger(db);

    console.log(
      JSON.stringify({
        type: "d1_l71_parity_tests_ok",
        checks: [
          "status_matrix_supabase_parity",
          "concurrent_claim_single_winner",
          "reclaim_race_not_error",
          "owner_mismatch_finalize",
          "stale_to_ambiguous",
          "success_reclaim_already_synced",
          "list_for_shipment_order_and_fields",
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
