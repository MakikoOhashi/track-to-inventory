/**
 * Usage / plan gateway (Stage L5.5).
 *
 * D1 is the sole authority for OCR / AI / delete / plan.
 * No Redis contact. No USAGE_D1_MODE flag.
 *
 * SI registration limits use D1 counts + D1 plan.
 */

import { randomUUID } from "node:crypto";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { classifyD1Error, safeErrorName } from "~/lib/d1/errors.server";
import {
  createShopPlanRepository,
  createUsageQuotaRepository,
  normalizeUserPlan,
  utcPeriodYm,
  type UsageKind,
  type UserPlan,
} from "~/lib/d1/index.server";
import { createShipmentsRepository } from "~/lib/d1/shipments.server";

export type UsageReserveKind = "ocr" | "ai";

export type ReserveUsageGatewayResult = {
  operationId: string;
  source: "d1";
};

export type UsageDisplay = {
  plan: UserPlan;
  month: string;
  usage: {
    ai: { current: number; limit: number; remaining: number };
    ocr: { current: number; limit: number; remaining: number };
    si: { current: number; limit: number; remaining: number };
  };
};

const D1_TIMEOUT_MS = 800;

const SI_LIMITS: Record<UserPlan, number> = {
  free: 10,
  basic: 100,
  pro: Number.POSITIVE_INFINITY,
};

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
      usage_authority: "d1",
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

async function fetchSiCount(shopId: string): Promise<number> {
  try {
    return await createShipmentsRepository(requireDb()).countByShop(shopId);
  } catch {
    return 0;
  }
}

/**
 * Authorize + count OCR/AI usage on D1.
 * Returns operationId for later refund on processing failure.
 */
export async function reserveOcrOrAiUsage(params: {
  shopId: string;
  kind: UsageReserveKind;
  operationId?: string;
}): Promise<ReserveUsageGatewayResult> {
  const operationId = params.operationId || randomUUID();
  await d1Reserve({
    shopId: params.shopId,
    kind: params.kind,
    operationId,
  });
  return { operationId, source: "d1" };
}

/** Refund after OCR/AI processing failure. */
export async function refundOcrOrAiUsage(params: {
  shopId: string;
  kind: UsageReserveKind;
  operationId: string;
}): Promise<void> {
  if (!params.operationId) return;
  await d1Refund(params.operationId);
}

/** Delete limit check — before mutation (same timing as legacy). */
export async function checkDeleteUsageLimit(
  shopId: string,
  limit: number = 2,
): Promise<void> {
  const period = utcPeriodYm();
  const count = await d1GetCount(shopId, "delete", period);
  if (count >= limit) throw new Error("DELETE_LIMIT_EXCEEDED");
}

/**
 * Record delete usage after successful delete (same success condition as legacy).
 */
export async function recordDeleteUsage(params: {
  shopId: string;
  operationId?: string;
}): Promise<void> {
  const operationId = params.operationId || randomUUID();
  await d1Reserve({
    shopId: params.shopId,
    kind: "delete",
    operationId,
  });
}

/** Usage display for /api/usage — D1 snapshot + D1 shipment count. */
export async function getUsageForDisplay(shopId: string): Promise<UsageDisplay> {
  const db = requireDb();
  const repo = createUsageQuotaRepository(db);
  const snap = await withTimeout(repo.getSnapshot(shopId), D1_TIMEOUT_MS);
  const plan = snap.plan;
  const siLimit = SI_LIMITS[plan];
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

/** Persist plan after Shopify Billing confirmation — D1 only. */
export async function persistUserPlan(
  shopId: string,
  plan: UserPlan | string,
  source: string = "shopify_billing",
): Promise<void> {
  const normalized = normalizeUserPlan(plan);
  try {
    await d1UpsertPlan(shopId, normalized, source);
    logUsage({
      type: "usage_d1_plan_write_success",
      shop: shopId,
      plan: normalized,
      source,
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    logUsage({
      type: "usage_d1_plan_write_error",
      shop: shopId,
      plan: normalized,
      source,
      error_class: classified.classification,
      error_name: safeErrorName(error),
    });
    throw error;
  }
}

/** Plan read from D1. */
export async function getPlanViaGateway(shopId: string): Promise<UserPlan> {
  return d1GetPlan(shopId);
}

/**
 * SI registration limit check (D1 count + D1 plan).
 * Kept here so plan is never read from Redis.
 */
export async function checkSILimit(shopId: string): Promise<void> {
  const plan = await getPlanViaGateway(shopId);
  const limit = SI_LIMITS[plan];
  if (!Number.isFinite(limit)) return;

  const currentCount = await fetchSiCount(shopId);
  if (currentCount >= limit) {
    throw new Error("SI_LIMIT_EXCEEDED");
  }
}
