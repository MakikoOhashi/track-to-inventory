/**
 * Usage / plan gateway (Stage L5.3).
 *
 * Routes call this instead of redis.server usage helpers directly.
 * Mode via USAGE_D1_MODE: redis | shadow | d1_only.
 *
 * shadow: Redis remains authority for authorize + returned values;
 *         D1 gets the same reserve/refund/plan writes; diffs are logged.
 * d1_only: D1 alone; Redis not contacted for usage/plan.
 */

import { randomUUID } from "node:crypto";
import {
  getCloudflareCtx,
  getOptionalTtiDb,
} from "~/lib/cloudflareBindings.server";
import { classifyD1Error, safeErrorName } from "~/lib/d1/errors.server";
import {
  createShopPlanRepository,
  createUsageQuotaRepository,
  limitFor,
  normalizeUserPlan,
  utcPeriodYm,
  type UsageKind,
  type UserPlan,
} from "~/lib/d1/index.server";
import {
  checkAndIncrementAI,
  checkAndIncrementOCR,
  checkDeleteLimit,
  getUserPlan,
  getUserUsage,
  incrementDeleteCount,
  setUserPlan,
} from "~/lib/redis.server";
import {
  getUsageD1Mode,
  isUsageD1OnlyActive,
  isUsageD1ShadowActive,
  isUsageD1WriteActive,
} from "~/lib/usageD1Mode.server";

export type UsageReserveKind = "ocr" | "ai";

export type ReserveUsageGatewayResult = {
  operationId: string;
  source: "redis" | "d1" | "shadow";
};

type UsageDisplay = Awaited<ReturnType<typeof getUserUsage>>;

const D1_TIMEOUT_MS = 800;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("usage_d1_timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function logUsage(entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({
      ...entry,
      usage_d1_mode: getUsageD1Mode(),
      primary_namespace: "tti",
    });
    if (/shpat_|sk_live|eyJhbGci/i.test(line)) return;
    console.log(line);
  } catch {
    // never affect request path
  }
}

function limitErrorFor(kind: UsageReserveKind): string {
  return kind === "ocr" ? "OCR_LIMIT_EXCEEDED" : "AI_LIMIT_EXCEEDED";
}

function requireDb(): D1Database {
  const db = getOptionalTtiDb();
  if (!db) throw new Error("TTI_DB binding is not configured");
  return db;
}

async function d1Reserve(params: {
  shopId: string;
  kind: UsageKind;
  operationId: string;
}): Promise<void> {
  const db = requireDb();
  const repo = createUsageQuotaRepository(db);
  const result = await withTimeout(
    repo.reserve({
      shopId: params.shopId,
      kind: params.kind,
      operationId: params.operationId,
    }),
    D1_TIMEOUT_MS,
  );
  if (!result.ok) {
    if (result.reason === "limit_exceeded") {
      if (params.kind === "delete") throw new Error("DELETE_LIMIT_EXCEEDED");
      throw new Error(limitErrorFor(params.kind));
    }
    throw new Error(`D1_RESERVE_FAILED:${result.reason}`);
  }
}

async function d1Refund(operationId: string): Promise<void> {
  const db = requireDb();
  const repo = createUsageQuotaRepository(db);
  await withTimeout(repo.refund({ operationId }), D1_TIMEOUT_MS);
}

async function d1GetCount(
  shopId: string,
  kind: UsageKind,
  periodYm: string,
): Promise<number> {
  const db = requireDb();
  const repo = createUsageQuotaRepository(db);
  return withTimeout(repo.getCount(shopId, kind, periodYm), D1_TIMEOUT_MS);
}

async function d1GetPlan(shopId: string): Promise<UserPlan> {
  const db = requireDb();
  const repo = createShopPlanRepository(db);
  return withTimeout(repo.getPlan(shopId), D1_TIMEOUT_MS);
}

async function d1UpsertPlan(
  shopId: string,
  plan: UserPlan,
  source: string,
): Promise<void> {
  const db = requireDb();
  const repo = createShopPlanRepository(db);
  await withTimeout(
    repo.upsertPlan({ shopId, plan, source, observedAt: new Date().toISOString() }),
    D1_TIMEOUT_MS,
  );
}

/** Best-effort D1 mirror; never throws to shadow callers. */
async function shadowD1Reserve(params: {
  shopId: string;
  kind: UsageKind;
  operationId: string;
}): Promise<void> {
  const started = Date.now();
  try {
    if (!getOptionalTtiDb()) {
      logUsage({
        type: "usage_d1_shadow_write_error",
        operation: "reserve",
        kind: params.kind,
        shop: params.shopId,
        operation_id: params.operationId,
        latency_ms: 0,
        error_class: "binding_missing",
      });
      return;
    }
    // Redis already authorized — do not re-enforce plan limit on the mirror path
    // (production counts may already exceed historical free limits).
    const db = requireDb();
    const repo = createUsageQuotaRepository(db);
    const result = await withTimeout(
      repo.reserve({
        shopId: params.shopId,
        kind: params.kind,
        operationId: params.operationId,
        limit: Number.POSITIVE_INFINITY,
      }),
      D1_TIMEOUT_MS,
    );
    if (!result.ok) {
      logUsage({
        type: "usage_d1_shadow_write_error",
        operation: "reserve",
        kind: params.kind,
        shop: params.shopId,
        operation_id: params.operationId,
        latency_ms: Date.now() - started,
        error_class: "reserve_rejected",
        error_name: result.reason,
      });
      return;
    }
    logUsage({
      type: "usage_d1_shadow_write_success",
      operation: "reserve",
      kind: params.kind,
      shop: params.shopId,
      operation_id: params.operationId,
      latency_ms: Date.now() - started,
      d1_count: result.count,
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    logUsage({
      type: "usage_d1_shadow_write_error",
      operation: "reserve",
      kind: params.kind,
      shop: params.shopId,
      operation_id: params.operationId,
      latency_ms: Date.now() - started,
      error_class: classified.classification,
      error_name: safeErrorName(error),
    });
  }
}

async function shadowD1Refund(operationId: string, kind: UsageKind, shopId: string): Promise<void> {
  const started = Date.now();
  try {
    if (!getOptionalTtiDb()) {
      logUsage({
        type: "usage_d1_shadow_write_error",
        operation: "refund",
        kind,
        shop: shopId,
        operation_id: operationId,
        latency_ms: 0,
        error_class: "binding_missing",
      });
      return;
    }
    await d1Refund(operationId);
    logUsage({
      type: "usage_d1_shadow_write_success",
      operation: "refund",
      kind,
      shop: shopId,
      operation_id: operationId,
      latency_ms: Date.now() - started,
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    logUsage({
      type: "usage_d1_shadow_write_error",
      operation: "refund",
      kind,
      shop: shopId,
      operation_id: operationId,
      latency_ms: Date.now() - started,
      error_class: classified.classification,
      error_name: safeErrorName(error),
    });
  }
}

/**
 * Authorize + count OCR/AI usage.
 * Returns operationId for later refund on processing failure.
 */
export async function reserveOcrOrAiUsage(params: {
  shopId: string;
  kind: UsageReserveKind;
  operationId?: string;
}): Promise<ReserveUsageGatewayResult> {
  const operationId = params.operationId || randomUUID();
  const mode = getUsageD1Mode();

  if (mode === "d1_only") {
    await d1Reserve({
      shopId: params.shopId,
      kind: params.kind,
      operationId,
    });
    return { operationId, source: "d1" };
  }

  // redis + shadow: Redis authorizes
  if (params.kind === "ocr") {
    await checkAndIncrementOCR(params.shopId);
  } else {
    await checkAndIncrementAI(params.shopId);
  }

  if (mode === "shadow") {
    // Mirror only when Redis would have incremented (finite plan limit).
    // Pro/unlimited Redis path no-ops the increment — skip D1 to avoid false diffs.
    const plan = normalizeUserPlan(await getUserPlan(params.shopId));
    const lim = limitFor(plan, params.kind);
    if (Number.isFinite(lim)) {
      await shadowD1Reserve({
        shopId: params.shopId,
        kind: params.kind,
        operationId,
      });
    }
  }

  return { operationId, source: mode === "shadow" ? "shadow" : "redis" };
}

/**
 * Refund after OCR/AI processing failure.
 * redis mode: no-op (historical Redis path never refunded).
 * shadow / d1_only: D1 refund.
 */
export async function refundOcrOrAiUsage(params: {
  shopId: string;
  kind: UsageReserveKind;
  operationId: string;
}): Promise<void> {
  if (!params.operationId) return;
  const mode = getUsageD1Mode();
  if (mode === "redis") return;

  if (mode === "d1_only") {
    await d1Refund(params.operationId);
    return;
  }

  await shadowD1Refund(params.operationId, params.kind, params.shopId);
}

/** Delete limit check — same timing as legacy (before mutation). */
export async function checkDeleteUsageLimit(
  shopId: string,
  limit: number = 2,
): Promise<void> {
  if (isUsageD1OnlyActive()) {
    const period = utcPeriodYm();
    const count = await d1GetCount(shopId, "delete", period);
    if (count >= limit) throw new Error("DELETE_LIMIT_EXCEEDED");
    return;
  }
  await checkDeleteLimit(shopId, limit);
}

/**
 * Record delete usage after successful delete (same success condition as legacy).
 */
export async function recordDeleteUsage(params: {
  shopId: string;
  operationId?: string;
}): Promise<void> {
  const operationId = params.operationId || randomUUID();
  const mode = getUsageD1Mode();

  if (mode === "d1_only") {
    await d1Reserve({
      shopId: params.shopId,
      kind: "delete",
      operationId,
    });
    return;
  }

  await incrementDeleteCount(params.shopId);

  if (mode === "shadow") {
    await shadowD1Reserve({
      shopId: params.shopId,
      kind: "delete",
      operationId,
    });
  }
}

function scheduleShadowCompare(work: () => Promise<void>): void {
  const ctx = getCloudflareCtx();
  const run = async () => {
    try {
      await work();
    } catch {
      // never surface
    }
  };
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run());
    return;
  }
  void run();
}

async function compareUsageShadow(shopId: string, redisUsage: UsageDisplay): Promise<void> {
  if (!getOptionalTtiDb()) return;
  const period = utcPeriodYm();
  const diffs: Array<Record<string, unknown>> = [];

  try {
    const d1Plan = await d1GetPlan(shopId);
    if (d1Plan !== redisUsage.plan) {
      diffs.push({ field: "plan", redis: redisUsage.plan, d1: d1Plan });
    }
    for (const kind of ["ocr", "ai"] as const) {
      const d1c = await d1GetCount(shopId, kind, period);
      const redisC = redisUsage.usage[kind].current;
      if (d1c !== redisC) {
        diffs.push({ field: kind, redis: redisC, d1: d1c, period_ym: period });
      }
    }
    // delete is not in display payload; still compare for ops visibility
    try {
      const { getStringPreferNew } = await import("~/lib/redisCompat.server");
      const { deleteUsageKey, deleteUsageKeyLegacy } = await import("~/lib/redisKeys.server");
      const { redis } = await import("~/lib/redis.server");
      const redisDelete = Number(
        (await getStringPreferNew(
          redis,
          deleteUsageKey(shopId, period),
          deleteUsageKeyLegacy(shopId, period),
        )) ?? 0,
      );
      const d1Delete = await d1GetCount(shopId, "delete", period);
      if (d1Delete !== redisDelete) {
        diffs.push({
          field: "delete",
          redis: redisDelete,
          d1: d1Delete,
          period_ym: period,
        });
      }
    } catch {
      // delete compare is best-effort
    }

    if (diffs.length > 0) {
      logUsage({
        type: "usage_d1_shadow_diff",
        shop: shopId,
        period_ym: period,
        diffs,
        returned_source: "redis",
      });
    } else {
      logUsage({
        type: "usage_d1_shadow_match",
        shop: shopId,
        period_ym: period,
        returned_source: "redis",
      });
    }
  } catch (error) {
    const classified = classifyD1Error(error);
    logUsage({
      type: "usage_d1_shadow_compare_error",
      shop: shopId,
      error_class: classified.classification,
      error_name: safeErrorName(error),
    });
  }
}

/**
 * Usage display for /api/usage.
 * shadow/redis: Redis payload; shadow schedules D1 diff log.
 * d1_only: D1 snapshot + Supabase SI (via getUserUsage SI path reused carefully).
 */
async function fetchSiCount(shopId: string): Promise<number> {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return 0;
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const { count, error } = await supabase
      .from("shipments")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shopId);
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

export async function getUsageForDisplay(shopId: string): Promise<UsageDisplay> {
  if (isUsageD1OnlyActive()) {
    const db = requireDb();
    const repo = createUsageQuotaRepository(db);
    const snap = await withTimeout(repo.getSnapshot(shopId), D1_TIMEOUT_MS);
    const plan = snap.plan;
    const siLimits: Record<UserPlan, number> = {
      free: 10,
      basic: 100,
      pro: Number.POSITIVE_INFINITY,
    };
    const siLimit = siLimits[plan];
    const siCurrent = await fetchSiCount(shopId);
    return {
      plan,
      month: snap.period_ym,
      usage: {
        ai: {
          current: snap.usage.ai.current,
          limit: snap.usage.ai.limit,
          remaining: snap.usage.ai.remaining,
        },
        ocr: {
          current: snap.usage.ocr.current,
          limit: snap.usage.ocr.limit,
          remaining: snap.usage.ocr.remaining,
        },
        si: {
          current: siCurrent,
          limit: siLimit,
          remaining:
            siLimit === Number.POSITIVE_INFINITY
              ? Number.POSITIVE_INFINITY
              : siLimit - siCurrent,
        },
      },
    };
  }

  const usage = await getUserUsage(shopId);
  if (isUsageD1ShadowActive()) {
    scheduleShadowCompare(() => compareUsageShadow(shopId, usage));
  }
  return usage;
}

/**
 * Persist plan after Shopify Billing confirmation.
 * redis: Redis only.
 * shadow: Redis + D1.
 * d1_only: D1 only (Redis untouched, not deleted).
 */
export async function persistUserPlan(
  shopId: string,
  plan: UserPlan | string,
  source: string = "shopify_billing",
): Promise<void> {
  const normalized = normalizeUserPlan(plan);
  const mode = getUsageD1Mode();

  if (mode !== "d1_only") {
    await setUserPlan(shopId, normalized);
  }

  if (isUsageD1WriteActive()) {
    try {
      await d1UpsertPlan(shopId, normalized, source);
      logUsage({
        type: "usage_d1_plan_write_success",
        shop: shopId,
        plan: normalized,
        source,
      });
    } catch (error) {
      if (mode === "d1_only") throw error;
      const classified = classifyD1Error(error);
      logUsage({
        type: "usage_d1_plan_write_error",
        shop: shopId,
        plan: normalized,
        source,
        error_class: classified.classification,
        error_name: safeErrorName(error),
      });
    }
  }
}

/** Plan read for callers that need it under the gateway. */
export async function getPlanViaGateway(shopId: string): Promise<UserPlan> {
  if (isUsageD1OnlyActive()) {
    return d1GetPlan(shopId);
  }
  const plan = await getUserPlan(shopId);
  if (isUsageD1ShadowActive()) {
    scheduleShadowCompare(async () => {
      try {
        if (!getOptionalTtiDb()) return;
        const d1 = await d1GetPlan(shopId);
        if (d1 !== plan) {
          logUsage({
            type: "usage_d1_shadow_diff",
            shop: shopId,
            diffs: [{ field: "plan", redis: plan, d1 }],
            returned_source: "redis",
          });
        }
      } catch {
        // ignore
      }
    });
  }
  return plan;
}
