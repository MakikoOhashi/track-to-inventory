/**
 * D1 usage counters + operation ledger (Stage L5.1).
 *
 * Atomic reserve / refund by operation_id (SQLite single-writer serialization):
 * 1. Idempotent read of usage_operations
 * 2. INSERT reserved row (unique operation_id)
 * 3. If reserved count for shop/kind/period > limit → DELETE this op → limit_exceeded
 * 4. Else sync usage_counters.count to reserved COUNT
 *
 * Refund: CAS reserved→refunded, then re-sync count. Double refund is idempotent.
 *
 * D1-backed usage repository. Not wired to production routes.
 */

import { D1_MIGRATION_VERSION, nowIso } from "./client.server";
import { classifyD1Error, isRetryableD1Error } from "./errors.server";
import {
  limitFor,
  utcPeriodYm,
  type UsageKind,
  type UserPlan,
} from "./planLimits.server";
import { createShopPlanRepository } from "./shopPlans.server";

async function withBusyRetry<T>(fn: () => Promise<T>, attempts = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const classified = classifyD1Error(error);
      const msg = error instanceof Error ? error.message : String(error);
      const busy =
        classified.classification === "busy" ||
        isRetryableD1Error(classified) ||
        /SQLITE_BUSY|database is locked|internal error/i.test(msg);
      if (!busy || i === attempts - 1) throw classified;
      await new Promise((r) => setTimeout(r, 15 + i * 25));
    }
  }
  throw classifyD1Error(last);
}

export type UsageOperationStatus = "reserved" | "refunded";

export type ReserveUsageResult =
  | {
      ok: true;
      status: "reserved" | "already_reserved";
      operation_id: string;
      shop_id: string;
      kind: UsageKind;
      period_ym: string;
      count: number;
      limit: number;
    }
  | {
      ok: false;
      reason: "limit_exceeded" | "invalid_operation_id" | "already_refunded";
      operation_id: string;
      shop_id: string;
      kind: UsageKind;
      period_ym: string;
      count: number;
      limit: number;
    };

export type RefundUsageResult =
  | {
      ok: true;
      status: "refunded" | "already_refunded";
      operation_id: string;
      shop_id: string;
      kind: UsageKind;
      period_ym: string;
      count: number;
    }
  | {
      ok: false;
      reason: "not_found" | "invalid_operation_id";
      operation_id: string;
    };

export type UsageSnapshot = {
  plan: UserPlan;
  period_ym: string;
  usage: Record<UsageKind, { current: number; limit: number; remaining: number }>;
};

export type UsageQuotaRepository = {
  getSnapshot: (shopId: string, at?: Date) => Promise<UsageSnapshot>;
  getCount: (shopId: string, kind: UsageKind, periodYm: string) => Promise<number>;
  reserve: (params: {
    shopId: string;
    kind: UsageKind;
    operationId: string;
    periodYm?: string;
    limit?: number;
  }) => Promise<ReserveUsageResult>;
  refund: (params: { operationId: string }) => Promise<RefundUsageResult>;
};

async function ensureShop(db: D1Database, shopId: string, ts: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO shops (
         shop_id, installed_at, uninstalled_at, plan_cached,
         migration_source, migration_version, created_at, updated_at
       ) VALUES (?, ?, NULL, NULL, 'runtime', ?, ?, ?)
       ON CONFLICT(shop_id) DO NOTHING`,
    )
    .bind(shopId, ts, D1_MIGRATION_VERSION, ts, ts)
    .run();
}

function remainingOf(current: number, limit: number): number {
  if (!Number.isFinite(limit)) return Number.POSITIVE_INFINITY;
  return limit - current;
}

export function createUsageQuotaRepository(db: D1Database): UsageQuotaRepository {
  const plans = createShopPlanRepository(db);

  async function countReserved(
    shopId: string,
    kind: UsageKind,
    periodYm: string,
  ): Promise<number> {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM usage_operations
         WHERE shop_id = ? AND kind = ? AND period_ym = ? AND status = 'reserved'`,
      )
      .bind(shopId, kind, periodYm)
      .first<{ c: number }>();
    return Number(row?.c ?? 0);
  }

  async function syncCounter(
    shopId: string,
    kind: UsageKind,
    periodYm: string,
    ts: string,
  ): Promise<number> {
    const count = await countReserved(shopId, kind, periodYm);
    await db
      .prepare(
        `INSERT INTO usage_counters (
           shop_id, kind, period_ym, count,
           migration_source, migration_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'runtime', ?, ?, ?)
         ON CONFLICT(shop_id, kind, period_ym) DO UPDATE SET
           count = excluded.count,
           updated_at = excluded.updated_at,
           migration_source = excluded.migration_source,
           migration_version = excluded.migration_version`,
      )
      .bind(shopId, kind, periodYm, count, D1_MIGRATION_VERSION, ts, ts)
      .run();
    return count;
  }

  async function getCount(
    shopId: string,
    kind: UsageKind,
    periodYm: string,
  ): Promise<number> {
    try {
      // Prefer live reserved count (source of truth); counter is denormalized.
      return await countReserved(shopId, kind, periodYm);
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function getSnapshot(shopId: string, at?: Date): Promise<UsageSnapshot> {
    const period_ym = utcPeriodYm(at);
    const plan = await plans.getPlan(shopId);
    const kinds: UsageKind[] = ["ai", "ocr", "delete"];
    const usage = {} as UsageSnapshot["usage"];
    for (const kind of kinds) {
      const current = await getCount(shopId, kind, period_ym);
      const limit = limitFor(plan, kind);
      usage[kind] = {
        current,
        limit,
        remaining: remainingOf(current, limit),
      };
    }
    return { plan, period_ym, usage };
  }

  async function readOperation(operationId: string): Promise<{
    operation_id: string;
    shop_id: string;
    kind: UsageKind;
    period_ym: string;
    status: UsageOperationStatus;
  } | null> {
    const raw = await db
      .prepare(
        `SELECT operation_id, shop_id, kind, period_ym, status
         FROM usage_operations WHERE operation_id = ?`,
      )
      .bind(operationId)
      .first<Record<string, unknown>>();
    if (!raw) return null;
    return {
      operation_id: String(raw.operation_id),
      shop_id: String(raw.shop_id),
      kind: String(raw.kind) as UsageKind,
      period_ym: String(raw.period_ym),
      status: String(raw.status) as UsageOperationStatus,
    };
  }

  async function reserve(params: {
    shopId: string;
    kind: UsageKind;
    operationId: string;
    periodYm?: string;
    limit?: number;
  }): Promise<ReserveUsageResult> {
    return withBusyRetry(() => reserveOnce(params));
  }

  async function reserveOnce(params: {
    shopId: string;
    kind: UsageKind;
    operationId: string;
    periodYm?: string;
    limit?: number;
  }): Promise<ReserveUsageResult> {
    const operationId = String(params.operationId || "").trim();
    const shopId = String(params.shopId || "").trim();
    const kind = params.kind;
    const periodYm = params.periodYm || utcPeriodYm();

    if (!operationId || !shopId) {
      return {
        ok: false,
        reason: "invalid_operation_id",
        operation_id: operationId,
        shop_id: shopId,
        kind,
        period_ym: periodYm,
        count: 0,
        limit: 0,
      };
    }

    try {
      const existing = await readOperation(operationId);
      if (existing) {
        const count = await countReserved(
          existing.shop_id,
          existing.kind,
          existing.period_ym,
        );
        const plan = await plans.getPlan(existing.shop_id);
        const limit = params.limit ?? limitFor(plan, existing.kind);
        if (existing.status === "reserved") {
          return {
            ok: true,
            status: "already_reserved",
            operation_id: operationId,
            shop_id: existing.shop_id,
            kind: existing.kind,
            period_ym: existing.period_ym,
            count,
            limit,
          };
        }
        return {
          ok: false,
          reason: "already_refunded",
          operation_id: operationId,
          shop_id: existing.shop_id,
          kind: existing.kind,
          period_ym: existing.period_ym,
          count,
          limit,
        };
      }

      const ts = nowIso();
      await ensureShop(db, shopId, ts);
      const plan = await plans.getPlan(shopId);
      const limit = params.limit ?? limitFor(plan, kind);

      let opIns;
      if (!Number.isFinite(limit)) {
        opIns = await db
          .prepare(
            `INSERT INTO usage_operations (
               operation_id, shop_id, kind, period_ym, status,
               migration_source, migration_version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'reserved', 'runtime', ?, ?, ?)`,
          )
          .bind(operationId, shopId, kind, periodYm, D1_MIGRATION_VERSION, ts, ts)
          .run();
      } else {
        // Single-statement gate: insert only while reserved count < limit.
        // Concurrent writers cannot permanently exceed the limit.
        opIns = await db
          .prepare(
            `INSERT INTO usage_operations (
               operation_id, shop_id, kind, period_ym, status,
               migration_source, migration_version, created_at, updated_at
             )
             SELECT ?, ?, ?, ?, 'reserved', 'runtime', ?, ?, ?
             WHERE (
               SELECT COUNT(*) FROM usage_operations
               WHERE shop_id = ? AND kind = ? AND period_ym = ? AND status = 'reserved'
             ) < ?`,
          )
          .bind(
            operationId,
            shopId,
            kind,
            periodYm,
            D1_MIGRATION_VERSION,
            ts,
            ts,
            shopId,
            kind,
            periodYm,
            limit,
          )
          .run();
      }

      if ((opIns.meta?.changes ?? 0) === 0) {
        // Either lost the unique race, or limit gate rejected the insert.
        const again = await readOperation(operationId);
        if (again) {
          return reserveOnce(params);
        }
        const count = await syncCounter(shopId, kind, periodYm, ts);
        return {
          ok: false,
          reason: "limit_exceeded",
          operation_id: operationId,
          shop_id: shopId,
          kind,
          period_ym: periodYm,
          count,
          limit,
        };
      }

      const count = await syncCounter(shopId, kind, periodYm, ts);
      return {
        ok: true,
        status: "reserved",
        operation_id: operationId,
        shop_id: shopId,
        kind,
        period_ym: periodYm,
        count,
        limit,
      };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function refund(params: {
    operationId: string;
  }): Promise<RefundUsageResult> {
    return withBusyRetry(() => refundOnce(params));
  }

  async function refundOnce(params: {
    operationId: string;
  }): Promise<RefundUsageResult> {
    const operationId = String(params.operationId || "").trim();
    if (!operationId) {
      return { ok: false, reason: "invalid_operation_id", operation_id: operationId };
    }

    try {
      const existing = await readOperation(operationId);
      if (!existing) {
        return { ok: false, reason: "not_found", operation_id: operationId };
      }
      if (existing.status === "refunded") {
        const count = await countReserved(
          existing.shop_id,
          existing.kind,
          existing.period_ym,
        );
        return {
          ok: true,
          status: "already_refunded",
          operation_id: operationId,
          shop_id: existing.shop_id,
          kind: existing.kind,
          period_ym: existing.period_ym,
          count,
        };
      }

      const ts = nowIso();
      const cas = await db
        .prepare(
          `UPDATE usage_operations
           SET status = 'refunded', updated_at = ?
           WHERE operation_id = ? AND status = 'reserved'`,
        )
        .bind(ts, operationId)
        .run();

      if ((cas.meta?.changes ?? 0) === 0) {
        return refundOnce(params);
      }

      const count = await syncCounter(
        existing.shop_id,
        existing.kind,
        existing.period_ym,
        ts,
      );
      return {
        ok: true,
        status: "refunded",
        operation_id: operationId,
        shop_id: existing.shop_id,
        kind: existing.kind,
        period_ym: existing.period_ym,
        count,
      };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  return { getSnapshot, getCount, reserve, refund };
}
