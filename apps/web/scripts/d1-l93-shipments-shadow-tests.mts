/**
 * Stage L9.3 shipments runtime shadow tests (local D1 only).
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { runWithCloudflareEnv } from "../app/lib/cloudflareBindings.server.ts";
import {
  executeDeleteShipmentFlow,
  type DeleteShipmentFlowDependencies,
  type DeleteShipmentMessages,
} from "../app/lib/deleteShipmentFlow.server.ts";
import {
  compareNormalizedShipments,
  compareShipmentLists,
  scheduleShipmentsShadowTask,
  shadowCompareCountAfterRead,
  shadowCompareGetAfterRead,
  shadowCompareListAfterRead,
  shadowWriteShipmentMirror,
  supabaseRawToComparable,
} from "../app/lib/d1ShipmentsShadow.server.ts";
import {
  getD1ShipmentsMode,
  getD1ShipmentsReadMode,
  getD1ShipmentsReadShopAllowlist,
  getD1ShipmentsWriteMode,
  isD1ShipmentsReadEnabledForShop,
  isD1ShipmentsPrimaryEnabled,
  isD1ShipmentsShadowActive,
} from "../app/lib/d1ShipmentsMode.server.ts";
import { createShipmentsReadGateway } from "../app/lib/d1ShipmentsReadGateway.server.ts";
import { createShipmentsRepository } from "../app/lib/d1/shipments.server.ts";
import type { SupabaseShipmentRow } from "../app/lib/d1/shipmentsBackfill.server.ts";
import { normalizeShopDomain } from "../app/utils/shopDomain.ts";

const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHOP_A = "l93-a.myshopify.com";
const SHOP_B = "l93-b.myshopify.com";

function row(
  overrides: Partial<SupabaseShipmentRow> = {},
): SupabaseShipmentRow {
  return {
    id: "00000000-0000-4000-8000-000000000931",
    shop_id: SHOP_A,
    si_number: "PRIVATE-SI-93",
    status: "輸送中",
    supplier_name: "Supplier",
    transport_type: "船便",
    memo: "full memo must never be logged",
    etd: "2026-07-01",
    eta: "2026-07-31",
    clearance_date: null,
    arrival_date: null,
    delayed: false,
    is_archived: false,
    invoice_url: "private/invoice.pdf",
    pl_url: null,
    si_url: null,
    other_url: null,
    items: [
      {
        sync_item_id: "line-1",
        name: "Item A",
        product_code: "A-1",
        quantity: 2,
        unit_price: "10.50",
        variant_id: "gid://shopify/ProductVariant/1",
      },
      {
        sync_item_id: "line-2",
        name: "Item B",
        product_code: "B-1",
        quantity: 3,
        unit_price: "20",
        variant_id: "gid://shopify/ProductVariant/2",
      },
    ],
    ...overrides,
  };
}

async function clearTestRows(db: D1Database) {
  await db.batch([
    db
      .prepare("DELETE FROM shipment_items WHERE shop_id IN (?, ?)")
      .bind(SHOP_A, SHOP_B),
    db
      .prepare("DELETE FROM shipments WHERE shop_id IN (?, ?)")
      .bind(SHOP_A, SHOP_B),
    db
      .prepare("DELETE FROM shops WHERE shop_id IN (?, ?)")
      .bind(SHOP_A, SHOP_B),
  ]);
}

const deleteMessages: DeleteShipmentMessages = {
  siNumberRequired: "SI number is required",
  shipmentNotFound: "Shipment not found",
  databaseError: "Database error",
  deleteFailed: "Delete failed",
  serverError: "Server error",
  success: "Deleted",
  authFailed: "Authentication failed",
};

function deleteRequest(): Request {
  const body = new FormData();
  body.set("siNumber", "DELETE-SI-93");
  return new Request("https://example.test/api/delete-shipment", {
    method: "DELETE",
    body,
  });
}

async function runDeleteHandlerTests() {
  function harness(
    options: {
      limitReached?: boolean;
      shadowFails?: boolean;
    } = {},
  ) {
    const events: string[] = [];
    const shadowErrors: string[] = [];
    const scheduled: Promise<void>[] = [];
    let primaryDeleteCount = 0;
    let shadowDeleteCount = 0;
    let usageCount = 0;

    const dependencies: DeleteShipmentFlowDependencies = {
      async requireAdminShop() {
        events.push("auth");
        return { ok: true, shop: SHOP_A };
      },
      createPrimaryGateway() {
        return {
          async find() {
            events.push("primary_find");
            return {
              data: row({ si_number: "DELETE-SI-93" }),
              error: null,
            };
          },
          async delete() {
            events.push("primary_delete");
            primaryDeleteCount += 1;
            return { error: null };
          },
        };
      },
      async checkDeleteUsageLimit() {
        events.push("usage_check");
        if (options.limitReached) throw new Error("DELETE_LIMIT_EXCEEDED");
      },
      async recordDeleteUsage() {
        events.push("usage_record");
        usageCount += 1;
      },
      scheduleShadowTask(task) {
        scheduled.push(
          task().catch(() => {
            shadowErrors.push("shipments_d1_shadow_write_error");
          }),
        );
      },
      async compareShadowRead() {
        events.push("shadow_read");
      },
      async deleteShadow() {
        events.push("shadow_delete");
        shadowDeleteCount += 1;
        if (options.shadowFails) throw new Error("simulated D1 failure");
      },
    };

    return {
      dependencies,
      events,
      scheduled,
      shadowErrors,
      get primaryDeleteCount() {
        return primaryDeleteCount;
      },
      get shadowDeleteCount() {
        return shadowDeleteCount;
      },
      get usageCount() {
        return usageCount;
      },
    };
  }

  // Below limit: primary delete, one shadow delete, and one usage increment.
  const success = harness();
  const successResult = await executeDeleteShipmentFlow({
    request: deleteRequest(),
    messages: deleteMessages,
    dependencies: success.dependencies,
  });
  await Promise.all(success.scheduled);
  assert.equal(successResult.status, 200);
  assert.deepEqual(successResult.body, { success: true, message: "Deleted" });
  assert.equal(success.primaryDeleteCount, 1);
  assert.equal(success.shadowDeleteCount, 1);
  assert.equal(success.usageCount, 1);
  assert.deepEqual(success.events, [
    "auth",
    "primary_find",
    "shadow_read",
    "usage_check",
    "primary_delete",
    "shadow_delete",
    "usage_record",
  ]);

  // At limit: no primary delete, shadow delete, or usage mutation.
  const limited = harness({ limitReached: true });
  const limitedResult = await executeDeleteShipmentFlow({
    request: deleteRequest(),
    messages: deleteMessages,
    dependencies: limited.dependencies,
  });
  await Promise.all(limited.scheduled);
  assert.equal(limitedResult.status, 403);
  assert.deepEqual(limitedResult.body, { error: "DELETE_LIMIT_EXCEEDED" });
  assert.equal(limited.primaryDeleteCount, 0);
  assert.equal(limited.shadowDeleteCount, 0);
  assert.equal(limited.usageCount, 0);

  // Shadow failure is observed but cannot replace the primary success response.
  const shadowFailure = harness({ shadowFails: true });
  const shadowFailureResult = await executeDeleteShipmentFlow({
    request: deleteRequest(),
    messages: deleteMessages,
    dependencies: shadowFailure.dependencies,
  });
  await Promise.all(shadowFailure.scheduled);
  assert.equal(shadowFailureResult.status, 200);
  assert.deepEqual(shadowFailureResult.body, {
    success: true,
    message: "Deleted",
  });
  assert.equal(shadowFailure.primaryDeleteCount, 1);
  assert.equal(shadowFailure.shadowDeleteCount, 1);
  assert.equal(shadowFailure.usageCount, 1);
  assert.deepEqual(shadowFailure.shadowErrors, [
    "shipments_d1_shadow_write_error",
  ]);
}

async function runReadGatewayTests() {
  const a = row({ id: "read-a", shop_id: SHOP_A, si_number: "READ-A" });
  const b = row({ id: "read-b", shop_id: SHOP_B, si_number: "READ-B" });
  let supabaseCalls = 0;
  let d1Calls = 0;
  const supabaseShopCalls: string[] = [];
  const d1ShopCalls: string[] = [];
  const fallbackLogs: Array<Record<string, unknown>> = [];
  const rows = new Map([
    [SHOP_A, [a]],
    [SHOP_B, [b]],
  ]);
  const source = (kind: "supabase" | "d1") => ({
    async list(shopId: string) {
      if (kind === "supabase") {
        supabaseCalls++;
        supabaseShopCalls.push(shopId);
      } else {
        d1Calls++;
        d1ShopCalls.push(shopId);
      }
      return rows.get(shopId) ?? [];
    },
    async get(shopId: string, id: string) {
      if (kind === "supabase") {
        supabaseCalls++;
        supabaseShopCalls.push(shopId);
      } else {
        d1Calls++;
        d1ShopCalls.push(shopId);
      }
      return (rows.get(shopId) ?? []).find((entry) => entry.id === id);
    },
    async count(shopId: string) {
      if (kind === "supabase") {
        supabaseCalls++;
        supabaseShopCalls.push(shopId);
      } else {
        d1Calls++;
        d1ShopCalls.push(shopId);
      }
      return (rows.get(shopId) ?? []).length;
    },
  });

  const defaultGateway = createShipmentsReadGateway({
    isD1ReadEnabledForShop: () => false,
    supabase: source("supabase"),
    d1: source("d1"),
    log: () => undefined,
  });
  assert.equal((await defaultGateway.list(SHOP_A)).source, "supabase");
  assert.equal(supabaseCalls, 1);
  assert.equal(d1Calls, 0);

  const d1Gateway = createShipmentsReadGateway({
    isD1ReadEnabledForShop: (shop) => shop === SHOP_A,
    supabase: source("supabase"),
    d1: source("d1"),
    log: () => undefined,
  });
  const d1List = await d1Gateway.list(` ${SHOP_A.toUpperCase()}. `);
  assert.equal(d1List.source, "d1");
  assert.deepEqual(
    d1List.data.map((entry) => entry.id),
    ["read-a"],
  );
  assert.equal((await d1Gateway.get(SHOP_A, "read-b")).data, undefined);
  assert.equal((await d1Gateway.count(SHOP_A)).data, 1);
  assert.equal((await d1Gateway.list(SHOP_B)).source, "supabase");
  assert.deepEqual(
    (await d1Gateway.list(SHOP_B)).data.map((entry) => entry.id),
    ["read-b"],
    "allowlist-external shop must stay tenant-scoped to Supabase",
  );
  assert.ok(d1ShopCalls.every((shop) => shop === SHOP_A));
  assert.ok(!d1List.data.some((entry) => entry.shop_id === SHOP_B));

  const emptyGateway = createShipmentsReadGateway({
    isD1ReadEnabledForShop: (shop) => shop === SHOP_A,
    supabase: source("supabase"),
    d1: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async count() {
        return 0;
      },
    },
    log: () => undefined,
  });
  const beforeEmptyFallback = supabaseCalls;
  assert.deepEqual((await emptyGateway.list(SHOP_A)).data, []);
  assert.equal((await emptyGateway.get(SHOP_A, "missing")).data, undefined);
  assert.equal((await emptyGateway.count(SHOP_A)).data, 0);
  assert.equal(
    supabaseCalls,
    beforeEmptyFallback,
    "empty D1 must not fallback",
  );

  const fallbackGateway = createShipmentsReadGateway({
    isD1ReadEnabledForShop: (shop) => shop === SHOP_A,
    supabase: source("supabase"),
    d1: {
      async list() {
        throw new Error("D1 unavailable");
      },
      async get() {
        throw new Error("D1 unavailable");
      },
      async count() {
        throw new Error("D1 unavailable");
      },
    },
    log: (entry) => fallbackLogs.push(entry),
  });
  assert.deepEqual(
    (await fallbackGateway.list(SHOP_A)).data.map((entry) => entry.id),
    ["read-a"],
  );
  assert.equal((await fallbackGateway.get(SHOP_A, "read-b")).data, undefined);
  assert.equal((await fallbackGateway.count(SHOP_A)).data, 1);
  assert.deepEqual(
    fallbackLogs
      .filter((entry) => entry.type === "shipments_d1_read_fallback")
      .map((entry) => entry.operation),
    ["list", "get", "count"],
  );
  assert.ok(
    fallbackLogs
      .filter((entry) => entry.type === "shipments_d1_read_fallback")
      .every(
        (entry) =>
          entry.type === "shipments_d1_read_fallback" &&
          typeof entry.shop_id === "string" &&
          typeof entry.error_class === "string",
      ),
  );
  assert.deepEqual(
    fallbackLogs
      .filter((entry) => entry.type === "shipments_read_source")
      .map((entry) => entry.source),
    ["supabase_fallback", "supabase_fallback", "supabase_fallback"],
  );
  assert.ok(
    supabaseShopCalls.slice(-3).every((shop) => shop === SHOP_A),
    "fallback must use the same authenticated tenant",
  );

  const queryWithOtherShop = new Request(
    `https://example.test/app?shop=${SHOP_B}`,
  );
  assert.equal(queryWithOtherShop.url.includes(SHOP_B), true);
  assert.deepEqual(
    (await d1Gateway.list(normalizeShopDomain(SHOP_A))).data.map(
      (entry) => entry.id,
    ),
    ["read-a"],
    "query shop must not replace the authenticated shop passed to the gateway",
  );
}

async function main() {
  await runDeleteHandlerTests();
  await runReadGatewayTests();

  assert.equal(getD1ShipmentsMode({ D1_SHIPMENTS_MODE: "shadow" }), "shadow");
  assert.equal(getD1ShipmentsMode({ D1_SHIPMENTS_MODE: "d1" }), "d1");
  assert.equal(getD1ShipmentsMode({}), "off");
  assert.equal(getD1ShipmentsMode({ D1_SHIPMENTS_MODE: "invalid" }), "off");
  assert.equal(
    isD1ShipmentsShadowActive({ D1_SHIPMENTS_MODE: "shadow" }),
    true,
  );
  assert.equal(isD1ShipmentsShadowActive({ D1_SHIPMENTS_MODE: "d1" }), true);
  assert.equal(isD1ShipmentsShadowActive({}), false);
  assert.equal(
    isD1ShipmentsShadowActive({ D1_SHIPMENTS_MODE: "invalid" }),
    false,
  );
  assert.equal(isD1ShipmentsPrimaryEnabled(), false);
  assert.equal(getD1ShipmentsReadMode({}), "supabase");
  assert.equal(
    getD1ShipmentsReadMode({ D1_SHIPMENTS_READ_MODE: "invalid" }),
    "supabase",
  );
  assert.equal(getD1ShipmentsReadMode({ D1_SHIPMENTS_READ_MODE: "d1" }), "d1");
  assert.deepEqual(
    [
      ...getD1ShipmentsReadShopAllowlist({
        D1_SHIPMENTS_READ_SHOP_ALLOWLIST: ` ${SHOP_A.toUpperCase()}. , ${SHOP_B}, invalid.example.com, ,`,
      }),
    ],
    [SHOP_A, SHOP_B],
  );
  assert.equal(
    getD1ShipmentsReadShopAllowlist({
      D1_SHIPMENTS_READ_SHOP_ALLOWLIST: "",
    }).size,
    0,
  );
  assert.equal(getD1ShipmentsReadShopAllowlist({}).size, 0);
  assert.equal(
    isD1ShipmentsReadEnabledForShop(SHOP_A, {
      D1_SHIPMENTS_READ_MODE: "d1",
      D1_SHIPMENTS_READ_SHOP_ALLOWLIST: SHOP_A,
    }),
    true,
  );
  assert.equal(
    isD1ShipmentsReadEnabledForShop(SHOP_A, {
      D1_SHIPMENTS_READ_MODE: "supabase",
      D1_SHIPMENTS_READ_SHOP_ALLOWLIST: SHOP_A,
    }),
    false,
  );
  assert.equal(
    isD1ShipmentsReadEnabledForShop(SHOP_A, {
      D1_SHIPMENTS_READ_MODE: "d1",
      D1_SHIPMENTS_READ_SHOP_ALLOWLIST: "",
    }),
    false,
  );
  assert.equal(
    isD1ShipmentsReadEnabledForShop(`prefix-${SHOP_A}`, {
      D1_SHIPMENTS_READ_MODE: "d1",
      D1_SHIPMENTS_READ_SHOP_ALLOWLIST: SHOP_A,
    }),
    false,
    "partial or similar domains must not match",
  );
  assert.equal(
    isD1ShipmentsReadEnabledForShop(SHOP_A, {
      D1_SHIPMENTS_READ_MODE: "d1",
      D1_SHIPMENTS_READ_SHOP_ALLOWLIST: `prefix-${SHOP_A}`,
    }),
    false,
    "allowlist matching must be exact",
  );
  assert.equal(
    isD1ShipmentsPrimaryEnabled({
      D1_SHIPMENTS_READ_MODE: "d1",
      D1_SHIPMENTS_READ_SHOP_ALLOWLIST: SHOP_A,
    }),
    true,
  );
  assert.equal(
    isD1ShipmentsPrimaryEnabled({
      D1_SHIPMENTS_READ_MODE: "d1",
    }),
    false,
  );
  assert.equal(
    getD1ShipmentsWriteMode({ D1_SHIPMENTS_MODE: "shadow" }),
    "shadow",
  );
  assert.equal(getD1ShipmentsWriteMode({ D1_SHIPMENTS_MODE: "d1" }), "shadow");
  assert.equal(
    getD1ShipmentsWriteMode({
      D1_SHIPMENTS_MODE: "shadow",
      D1_SHIPMENTS_WRITE_MODE: "invalid",
    }),
    "off",
  );
  assert.equal(
    isD1ShipmentsShadowActive({
      D1_SHIPMENTS_READ_MODE: "d1",
      D1_SHIPMENTS_WRITE_MODE: "shadow",
    }),
    true,
  );

  const proxy = await getPlatformProxy({
    configPath: join(webRoot, "wrangler.jsonc"),
    persist: true,
  });
  const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
  const originalMode = process.env.D1_SHIPMENTS_MODE;
  const originalLog = console.log;
  const logs: Array<Record<string, unknown>> = [];

  console.log = (value?: unknown) => {
    if (typeof value === "string" && value.startsWith("{")) {
      logs.push(JSON.parse(value));
    }
  };
  process.env.D1_SHIPMENTS_MODE = "shadow";

  try {
    await clearTestRows(db);

    let releaseScheduledTask: (() => void) | undefined;
    let attachedTask: Promise<unknown> | undefined;
    const lifecycleCtx = {
      waitUntil(promise: Promise<unknown>) {
        attachedTask = promise;
      },
    } as ExecutionContext;
    runWithCloudflareEnv({ env: proxy.env as Env, ctx: lifecycleCtx }, () => {
      scheduleShipmentsShadowTask(
        () =>
          new Promise<void>((resolve) => {
            releaseScheduledTask = resolve;
          }),
      );
      assert.ok(attachedTask, "shadow task must attach to waitUntil");
    });
    assert.ok(
      releaseScheduledTask,
      "scheduler must return before task settles",
    );
    releaseScheduledTask();
    await attachedTask;

    await runWithCloudflareEnv(
      { env: proxy.env as Env, ctx: {} as ExecutionContext },
      async () => {
        const primary = row();
        const repo = createShipmentsRepository(db);

        // create + retry: one shipment, no duplicate items
        await shadowWriteShipmentMirror({
          operation: "create",
          shopId: SHOP_A,
          row: primary,
        });
        await shadowWriteShipmentMirror({
          operation: "create",
          shopId: SHOP_A,
          row: primary,
        });
        assert.equal(await repo.countByShop(SHOP_A), 1);
        assert.equal(
          (await repo.getByShopAndSi(SHOP_A, primary.si_number))?.items.length,
          2,
        );

        // match across get/list/count and stable list ordering
        await shadowCompareGetAfterRead({
          shopId: SHOP_A,
          siNumber: primary.si_number,
          primaryRow: primary,
        });
        await shadowCompareListAfterRead({
          shopId: SHOP_A,
          primaryRows: [primary],
        });
        await shadowCompareCountAfterRead({ shopId: SHOP_A, primaryCount: 1 });
        assert.deepEqual(
          compareNormalizedShipments(
            supabaseRawToComparable(primary),
            await repo.getByShopAndSi(SHOP_A, primary.si_number),
          ),
          [],
        );
        assert.deepEqual(
          compareShipmentLists(
            [primary],
            [(await repo.getByShopAndSi(SHOP_A, primary.si_number))!],
          ),
          [],
        );

        // field mismatch, missing and extra classifications
        await shadowCompareGetAfterRead({
          shopId: SHOP_A,
          siNumber: primary.si_number,
          primaryRow: row({ memo: "changed after backfill" }),
        });
        await shadowCompareGetAfterRead({
          shopId: SHOP_A,
          siNumber: "MISSING-IN-D1",
          primaryRow: row({
            id: "00000000-0000-4000-8000-000000000932",
            si_number: "MISSING-IN-D1",
          }),
        });
        await shadowCompareGetAfterRead({
          shopId: SHOP_A,
          siNumber: primary.si_number,
          primaryRow: null,
        });
        await shadowCompareCountAfterRead({ shopId: SHOP_A, primaryCount: 99 });

        // update replaces all items and removes stale rows
        const updated = row({
          memo: "updated",
          items: [
            {
              sync_item_id: "line-1",
              name: "Item A2",
              quantity: 5,
              variant_id: "gid://shopify/ProductVariant/1",
            },
          ],
        });
        await shadowWriteShipmentMirror({
          operation: "update",
          shopId: SHOP_A,
          row: updated,
        });
        const afterUpdate = await repo.getByShopAndSi(
          SHOP_A,
          updated.si_number,
        );
        assert.equal(afterUpdate?.items.length, 1);
        assert.equal(afterUpdate?.items[0]?.name, "Item A2");

        // shop boundary: wrong-shop delete cannot remove SHOP_A data
        await shadowWriteShipmentMirror({
          operation: "delete",
          shopId: SHOP_B,
          siNumber: updated.si_number,
        });
        assert.ok(await repo.getByShopAndSi(SHOP_A, updated.si_number));

        // idempotent delete
        await shadowWriteShipmentMirror({
          operation: "delete",
          shopId: SHOP_A,
          siNumber: updated.si_number,
        });
        await shadowWriteShipmentMirror({
          operation: "delete",
          shopId: SHOP_A,
          siNumber: updated.si_number,
        });
        assert.equal(await repo.countByShop(SHOP_A), 0);
        assert.equal(
          Number(
            (
              await db
                .prepare(
                  "SELECT COUNT(*) AS c FROM shipment_items WHERE shipment_id = ?",
                )
                .bind(updated.id)
                .first<{ c: number }>()
            )?.c ?? 0,
          ),
          0,
          "parent delete must cascade to shipment items",
        );

        // uninstall all is shop-scoped
        await shadowWriteShipmentMirror({
          operation: "create",
          shopId: SHOP_A,
          row: row(),
        });
        await shadowWriteShipmentMirror({
          operation: "create",
          shopId: SHOP_B,
          row: row({
            id: "00000000-0000-4000-8000-000000000933",
            shop_id: SHOP_B,
            items: [
              {
                sync_item_id: "shop-b-line-1",
                name: "Shop B Item",
                quantity: 1,
                variant_id: "gid://shopify/ProductVariant/93",
              },
            ],
          }),
        });
        await shadowWriteShipmentMirror({
          operation: "delete_all",
          shopId: SHOP_A,
        });
        assert.equal(await repo.countByShop(SHOP_A), 0);
        assert.equal(await repo.countByShop(SHOP_B), 1);
      },
    );

    // Missing D1 binding is logged and never rejects the primary path.
    await shadowCompareListAfterRead({ shopId: SHOP_A, primaryRows: [] });
    await shadowWriteShipmentMirror({
      operation: "create",
      shopId: SHOP_A,
      row: row(),
    });
    await shadowWriteShipmentMirror({
      operation: "delete",
      shopId: SHOP_A,
      siNumber: "DELETE-SI-93",
    });

    const readCategories = logs.flatMap((entry) =>
      Array.isArray(entry.categories) ? entry.categories : [],
    );
    for (const category of [
      "match",
      "missing_in_d1",
      "extra_in_d1",
      "field_mismatch",
      "count_mismatch",
      "d1_error",
    ]) {
      assert.ok(
        readCategories.includes(category),
        `missing log category: ${category}`,
      );
    }
    assert.ok(
      logs.some(
        (entry) =>
          entry.type === "shipments_d1_shadow_write_error" &&
          entry.operation === "delete",
      ),
      "shadow_write_error log",
    );

    const serialized = JSON.stringify(logs);
    assert.equal(serialized.includes("full memo must never be logged"), false);
    assert.equal(serialized.includes("PRIVATE-SI-93"), false);
    assert.equal(serialized.includes("private/invoice.pdf"), false);

    originalLog(
      JSON.stringify({
        type: "d1_l93_shipments_shadow_tests_ok",
        log_count: logs.length,
      }),
    );
  } finally {
    console.log = originalLog;
    if (originalMode === undefined) delete process.env.D1_SHIPMENTS_MODE;
    else process.env.D1_SHIPMENTS_MODE = originalMode;
    await clearTestRows(db);
    await proxy.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
