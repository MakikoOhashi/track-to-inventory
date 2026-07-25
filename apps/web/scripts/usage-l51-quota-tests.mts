/**
 * Stage L5.1 — D1 shop_plans / usage_counters / usage_operations tests (local).
 *   npm run test:usage:l51
 *
 * No Redis. No production route wiring.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import {
  createShopPlanRepository,
} from "../app/lib/d1/shopPlans.server.ts";
import {
  createUsageQuotaRepository,
} from "../app/lib/d1/usageQuota.server.ts";
import {
  normalizeUserPlan,
  utcPeriodYm,
  PLAN_LIMITS,
} from "../app/lib/d1/planLimits.server.ts";

const SHOP = "l51-test.myshopify.com";

async function main() {
  assert.equal(normalizeUserPlan(null), "free");
  assert.equal(normalizeUserPlan("PRO"), "pro");
  assert.equal(normalizeUserPlan("nope"), "free");
  assert.equal(utcPeriodYm(new Date(Date.UTC(2026, 6, 25))), "2026-07");
  assert.equal(PLAN_LIMITS.free.ocr, 3);

  const proxy = await getPlatformProxy({ persist: true });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;

    // Confirm usage_operations exists (migration 0002 applied locally)
    const tables = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='usage_operations'`,
      )
      .first<{ name: string }>();
    assert.equal(tables?.name, "usage_operations");

    await db.prepare("DELETE FROM usage_operations WHERE shop_id = ?").bind(SHOP).run();
    await db.prepare("DELETE FROM usage_counters WHERE shop_id = ?").bind(SHOP).run();
    await db.prepare("DELETE FROM shop_plans WHERE shop_id = ?").bind(SHOP).run();
    await db.prepare("DELETE FROM shops WHERE shop_id = ?").bind(SHOP).run();

    const plans = createShopPlanRepository(db);
    const usage = createUsageQuotaRepository(db);

    // --- plan missing → free ---
    assert.equal(await plans.getPlan(SHOP), "free");

    // --- plan upsert + older cannot overwrite newer ---
    const t1 = "2026-07-25T01:00:00.000Z";
    const t2 = "2026-07-25T02:00:00.000Z";
    const newer = await plans.upsertPlan({
      shopId: SHOP,
      plan: "basic",
      observedAt: t2,
      source: "shopify",
    });
    assert.equal(newer.applied, true);
    assert.equal(newer.plan, "basic");

    const stale = await plans.upsertPlan({
      shopId: SHOP,
      plan: "free",
      observedAt: t1,
      source: "stale",
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.plan, "basic");

    const equalTs = await plans.upsertPlan({
      shopId: SHOP,
      plan: "pro",
      observedAt: t2,
      source: "equal",
    });
    assert.equal(equalTs.applied, false, "equal timestamp must not overwrite");
    assert.equal(await plans.getPlan(SHOP), "basic");

    const invalidPlan = await plans.upsertPlan({
      shopId: SHOP,
      plan: "enterprise",
      observedAt: "2026-07-25T03:00:00.000Z",
    });
    assert.equal(invalidPlan.plan, "free");

    // reset to free for OCR limit=3 tests
    await plans.upsertPlan({
      shopId: SHOP,
      plan: "free",
      observedAt: "2026-07-25T04:00:00.000Z",
    });

    const period = "2026-07";

    // --- reserve up to limit ---
    const op1 = randomUUID();
    const r1 = await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: op1,
      periodYm: period,
    });
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.status, "reserved");
    assert.equal(r1.count, 1);

    // --- idempotent reserve ---
    const r1b = await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: op1,
      periodYm: period,
    });
    assert.equal(r1b.ok, true);
    if (r1b.ok) assert.equal(r1b.status, "already_reserved");
    assert.equal(r1b.count, 1, "double reserve must not double-count");

    await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: randomUUID(),
      periodYm: period,
    });
    await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: randomUUID(),
      periodYm: period,
    });

    const over = await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: randomUUID(),
      periodYm: period,
    });
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.reason, "limit_exceeded");
    assert.equal(over.count, 3);

    // --- parallel reserves must not exceed limit ---
    // Local miniflare D1 serializes writes; Promise.all still exercises races + busy retry.
    await db.prepare("DELETE FROM usage_operations WHERE shop_id = ?").bind(SHOP).run();
    await db.prepare("DELETE FROM usage_counters WHERE shop_id = ?").bind(SHOP).run();
    await new Promise((r) => setTimeout(r, 50));

    const parallelIds = Array.from({ length: 10 }, () => randomUUID());
    const parallel = await Promise.all(
      parallelIds.map((operationId) =>
        usage.reserve({
          shopId: SHOP,
          kind: "ocr",
          operationId,
          periodYm: period,
          limit: 3,
        }),
      ),
    );
    const okCount = parallel.filter((r) => r.ok).length;
    const exceeded = parallel.filter((r) => !r.ok && r.reason === "limit_exceeded").length;
    assert.equal(okCount, 3, `expected 3 ok, got ${okCount}`);
    assert.equal(exceeded, 7);
    assert.equal(await usage.getCount(SHOP, "ocr", period), 3);

    // --- refund + double refund ---
    const reservedOp = parallel.find((r) => r.ok);
    assert.ok(reservedOp && reservedOp.ok);
    const refund1 = await usage.refund({ operationId: reservedOp.operation_id });
    assert.equal(refund1.ok, true);
    if (refund1.ok) assert.equal(refund1.status, "refunded");
    assert.equal(refund1.count, 2);

    const refund2 = await usage.refund({ operationId: reservedOp.operation_id });
    assert.equal(refund2.ok, true);
    if (refund2.ok) assert.equal(refund2.status, "already_refunded");
    assert.equal(refund2.count, 2, "double refund must not go negative twice");

    // refunded op cannot reserve again
    const reReserve = await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: reservedOp.operation_id,
      periodYm: period,
    });
    assert.equal(reReserve.ok, false);
    if (!reReserve.ok) assert.equal(reReserve.reason, "already_refunded");

    // after refund, new op can take the slot
    const afterRefund = await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: randomUUID(),
      periodYm: period,
      limit: 3,
    });
    assert.equal(afterRefund.ok, true);
    assert.equal(await usage.getCount(SHOP, "ocr", period), 3);

    // --- month boundary isolation ---
    const nextMonth = await usage.reserve({
      shopId: SHOP,
      kind: "ocr",
      operationId: randomUUID(),
      periodYm: "2026-08",
      limit: 3,
    });
    assert.equal(nextMonth.ok, true);
    assert.equal(await usage.getCount(SHOP, "ocr", "2026-07"), 3);
    assert.equal(await usage.getCount(SHOP, "ocr", "2026-08"), 1);

    // --- AI / delete kinds ---
    const ai = await usage.reserve({
      shopId: SHOP,
      kind: "ai",
      operationId: randomUUID(),
      periodYm: period,
    });
    assert.equal(ai.ok, true);
    const del = await usage.reserve({
      shopId: SHOP,
      kind: "delete",
      operationId: randomUUID(),
      periodYm: period,
    });
    assert.equal(del.ok, true);

    // --- pro unlimited OCR ---
    await plans.upsertPlan({
      shopId: SHOP,
      plan: "pro",
      observedAt: "2026-07-25T05:00:00.000Z",
    });
    const unlimitedPeriod = "2026-09";
    for (let i = 0; i < 5; i++) {
      const u = await usage.reserve({
        shopId: SHOP,
        kind: "ocr",
        operationId: randomUUID(),
        periodYm: unlimitedPeriod,
      });
      assert.equal(u.ok, true);
    }
    assert.equal(await usage.getCount(SHOP, "ocr", unlimitedPeriod), 5);

    const snap = await usage.getSnapshot(SHOP, new Date(Date.UTC(2026, 8, 1)));
    assert.equal(snap.plan, "pro");
    assert.equal(snap.period_ym, "2026-09");
    assert.equal(snap.usage.ocr.current, 5);
    assert.equal(snap.usage.ocr.limit, Number.POSITIVE_INFINITY);

    // --- no Redis imports in modules ---
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const rel of [
      "app/lib/d1/usageQuota.server.ts",
      "app/lib/d1/shopPlans.server.ts",
      "app/lib/d1/planLimits.server.ts",
    ]) {
      const src = readFileSync(join(root, rel), "utf8");
      assert.ok(!src.includes("@upstash/redis"));
      assert.ok(!src.includes("UPSTASH_REDIS"));
      assert.ok(!src.includes("redis.server"));
    }

    console.log(
      JSON.stringify({
        type: "usage_l51_quota_tests_ok",
        checks: [
          "plan_missing_free",
          "plan_stale_no_overwrite",
          "plan_equal_ts_no_overwrite",
          "plan_invalid_to_free",
          "reserve_limit",
          "idempotent_reserve",
          "parallel_no_overage",
          "refund",
          "double_refund",
          "month_boundary",
          "ai_delete_kinds",
          "pro_unlimited",
          "no_redis_coupling",
        ],
      }),
    );
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
