/**
 * Stage L2 D1 shadow behavior tests (local D1 only).
 * Does not call Shopify, Supabase, or Redis.
 *
 * Run: npm run test:d1:l2
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { getPlatformProxy } from "wrangler";
import {
  classifyD1ShadowClaim,
  logD1ShadowDiff,
  shadowClaimOnD1,
  shadowFinalizeOnD1,
  shadowMarkAmbiguousOnD1,
} from "../app/lib/d1LedgerShadow.server.ts";
import {
  getD1LedgerMode,
  isD1LedgerPrimaryEnabled,
  isD1LedgerShadowActive,
} from "../app/lib/d1LedgerMode.server.ts";
import { createInventorySyncLedgerRepository } from "../app/lib/d1/inventorySyncLedger.server.ts";
import type { ClaimResult } from "../app/lib/syncLedger.server.ts";

// Mirror ALS used by cloudflareBindings — inject TTI_DB for shadow helpers.
const bindingAls = new AsyncLocalStorage<{ env: { TTI_DB: D1Database } }>();

// Patch getOptionalTtiDb by setting process and importing after env mode
import * as bindings from "../app/lib/cloudflareBindings.server.ts";

async function withDb<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  return bindings.runWithCloudflareEnv(
    { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
    fn,
  );
}

function primary(
  action: ClaimResult["action"],
  status?: string,
): ClaimResult {
  return {
    action,
    row: status
      ? ({
          id: "p1",
          shop_id: "a.myshopify.com",
          si_number: "SI",
          item_key: "i",
          variant_id: "v",
          inventory_item_id: null,
          location_id: null,
          delta_quantity: 1,
          idempotency_key: "k",
          status: status as any,
          attempt_count: 1,
          started_at: null,
          completed_at: null,
          shopify_adjustment_id: null,
          error_code: null,
          error_message: null,
        } as any)
      : undefined,
  };
}

async function main() {
  // mode helpers
  assert.equal(getD1LedgerMode({ D1_LEDGER_MODE: "shadow" }), "shadow");
  assert.equal(getD1LedgerMode({ D1_LEDGER_MODE: "nope" }), "off");
  assert.equal(isD1LedgerPrimaryEnabled(), false);
  process.env.D1_LEDGER_MODE = "off";
  assert.equal(isD1LedgerShadowActive(), false);

  assert.equal(
    classifyD1ShadowClaim(primary("already_synced", "succeeded"), {
      action: "already_synced",
    }),
    "already_synced_match",
  );
  assert.equal(
    classifyD1ShadowClaim(primary("claimed", "processing"), {
      action: "claimed",
    }),
    "claimable_match",
  );
  assert.equal(
    classifyD1ShadowClaim(primary("claimed", "processing"), {
      action: "error",
      missing: true,
    }),
    "missing_in_d1",
  );

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    await db.prepare("DELETE FROM inventory_sync_ledger").run();

    // off → no writes when shadow helpers respect mode
    process.env.D1_LEDGER_MODE = "off";
    let claimCalls = 0;
    const origLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(String(args[0] ?? ""));
    };

    await withDb(db, async () => {
      await shadowClaimOnD1({
        correlationId: "c-off",
        primary: primary("already_synced", "succeeded"),
        shopId: "shop-a.myshopify.com",
        siNumber: "SI-OFF",
        itemKey: "item-off",
        variantId: "v",
        deltaQuantity: 1,
        idempotencyKey: "idem-off",
      });
    });
    const countOff = await db
      .prepare("SELECT COUNT(*) AS c FROM inventory_sync_ledger")
      .first<{ c: number }>();
    assert.equal(Number(countOff?.c), 0, "mode=off must not write D1");

    // seed succeeded → already_synced_match path
    process.env.D1_LEDGER_MODE = "shadow";
    const repo = createInventorySyncLedgerRepository(db);
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO inventory_sync_ledger (
           id, shop_id, si_number, item_key, idempotency_key, variant_id,
           delta_quantity, status, attempt_count, started_at, completed_at, succeeded_at,
           created_at, updated_at, migration_source, migration_version, row_version
         ) VALUES (?, ?, ?, ?, ?, ?, 2, 'succeeded', 1, ?, ?, ?, ?, ?, 'test', 'l2', 1)`,
      )
      .bind(
        "seed-1",
        "shop-a.myshopify.com",
        "SI-1",
        "item-1",
        "idem-seed-1",
        "gid://v/1",
        now,
        now,
        now,
        now,
        now,
      )
      .run();

    logs.length = 0;
    await withDb(db, async () => {
      await shadowClaimOnD1({
        correlationId: "c-seed",
        primary: {
          action: "already_synced",
          row: {
            id: "seed-1",
            shop_id: "shop-a.myshopify.com",
            si_number: "SI-1",
            item_key: "item-1",
            variant_id: "gid://v/1",
            inventory_item_id: null,
            location_id: null,
            delta_quantity: 2,
            idempotency_key: "idem-seed-1",
            status: "succeeded",
            attempt_count: 1,
            started_at: now,
            completed_at: now,
            shopify_adjustment_id: null,
            error_code: null,
            error_message: null,
          },
        },
        shopId: "shop-a.myshopify.com",
        siNumber: "SI-1",
        itemKey: "item-1",
        variantId: "gid://v/1",
        deltaQuantity: 2,
        idempotencyKey: "idem-seed-1",
      });
    });
    assert.ok(
      logs.some((l) => l.includes("already_synced_match")),
      "expected already_synced_match log",
    );

    // new claim → claimable_match
    logs.length = 0;
    await withDb(db, async () => {
      await shadowClaimOnD1({
        correlationId: "c-new",
        primary: { action: "claimed" },
        shopId: "shop-a.myshopify.com",
        siNumber: "SI-2",
        itemKey: "item-2",
        variantId: "gid://v/2",
        deltaQuantity: 1,
        idempotencyKey: "idem-new-1",
      });
    });
    assert.ok(logs.some((l) => l.includes("claimable_match")));

    const claimed = await repo.findByIdempotencyKey("idem-new-1");
    assert.equal(claimed?.status, "processing");

    // finalize success on D1
    logs.length = 0;
    await withDb(db, async () => {
      await shadowFinalizeOnD1({
        correlationId: "c-fin",
        shopId: "shop-a.myshopify.com",
        idempotencyKey: "idem-new-1",
        outcome: "succeeded",
        shopifyAdjustmentId: "adj-1",
        primaryFinalizeOk: true,
      });
    });
    const done = await repo.findByIdempotencyKey("idem-new-1");
    assert.equal(done?.status, "succeeded");

    // owner mismatch finalize
    const c2 = await repo.claim({
      shopId: "shop-b.myshopify.com",
      siNumber: "SI-B",
      itemKey: "item-b",
      variantId: "vb",
      deltaQuantity: 1,
      idempotencyKey: "idem-owner",
    });
    assert.equal(c2.action, "claimed");
    const bad = await repo.finalizeSucceeded({
      id: c2.row!.id,
      claimToken: "wrong",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "OWNER_MISMATCH");

    // stale: no auto reclaim
    const stale = await repo.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-STALE",
      itemKey: "item-stale",
      variantId: "vs",
      deltaQuantity: 1,
      idempotencyKey: "idem-stale-l2",
    });
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await db
      .prepare(
        `UPDATE inventory_sync_ledger SET claimed_at = ?, started_at = ? WHERE id = ?`,
      )
      .bind(old, old, stale.row!.id)
      .run();
    const again = await repo.claim({
      shopId: "shop-a.myshopify.com",
      siNumber: "SI-STALE",
      itemKey: "item-stale",
      variantId: "vs",
      deltaQuantity: 1,
      idempotencyKey: "idem-stale-l2",
    });
    assert.equal(again.action, "in_progress");

    await withDb(db, async () => {
      await shadowMarkAmbiguousOnD1({
        correlationId: "c-stale",
        shopId: "shop-a.myshopify.com",
        idempotencyKey: "idem-stale-l2",
        staleBefore: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
    });
    const amb = await repo.findByIdempotencyKey("idem-stale-l2");
    assert.equal(amb?.status, "ambiguous");

    // shop A/B isolation
    const a = await repo.findByIdempotencyKey("idem-seed-1");
    const b = await repo.findByIdempotencyKey("idem-owner");
    assert.equal(a?.shop_id, "shop-a.myshopify.com");
    assert.equal(b?.shop_id, "shop-b.myshopify.com");

    // binding missing → d1_error, primary unaffected conceptually
    logs.length = 0;
    process.env.D1_LEDGER_MODE = "shadow";
    await bindings.runWithCloudflareEnv(
      { env: {} as Env, ctx: {} as ExecutionContext },
      async () => {
        await shadowClaimOnD1({
          correlationId: "c-miss",
          primary: { action: "claimed" },
          shopId: "shop-a.myshopify.com",
          siNumber: "SI-X",
          itemKey: "item-x",
          variantId: "vx",
          deltaQuantity: 1,
          idempotencyKey: "idem-bind-miss",
        });
      },
    );
    assert.ok(logs.some((l) => l.includes("binding_missing")));
    assert.ok(logs.some((l) => l.includes('"category":"d1_error"')));

    // mutation success + D1 finalize failure (wrong token already finalized)
    logs.length = 0;
    await withDb(db, async () => {
      await shadowFinalizeOnD1({
        correlationId: "c-dup-fin",
        shopId: "shop-a.myshopify.com",
        idempotencyKey: "idem-new-1",
        outcome: "succeeded",
        primaryFinalizeOk: true,
      });
    });
    assert.ok(
      logs.some(
        (l) =>
          l.includes("already_synced_match") || l.includes("finalize_mismatch"),
      ),
    );

    console.log = origLog;
    void claimCalls;
    void logD1ShadowDiff;
    void bindingAls;

    await db.prepare("DELETE FROM inventory_sync_ledger").run();

    console.log(
      JSON.stringify({
        type: "d1_l2_shadow_tests_ok",
        checks: [
          "mode_off_no_write",
          "already_synced_match",
          "claimable_match",
          "finalize_success",
          "owner_mismatch",
          "stale_no_reclaim",
          "shop_isolation",
          "binding_missing",
          "primary_flag_disabled",
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
