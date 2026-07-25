/**
 * shop_plans repository (Stage L5.1).
 * Redis-free. Not wired to production routes.
 *
 * Plan updates are gated by observed_at / updated_at so an older refresh
 * cannot overwrite a newer one.
 */

import { D1_MIGRATION_VERSION, nowIso } from "./client.server";
import { classifyD1Error } from "./errors.server";
import { normalizeUserPlan, type UserPlan } from "./planLimits.server";

export type ShopPlanRow = {
  shop_id: string;
  plan: UserPlan;
  source: string | null;
  updated_at: string;
  created_at: string;
};

export type UpsertShopPlanInput = {
  shopId: string;
  plan: string;
  /** Observation time; defaults to now. Older timestamps do not overwrite newer rows. */
  observedAt?: string;
  source?: string;
};

export type ShopPlanRepository = {
  getPlan: (shopId: string) => Promise<UserPlan>;
  getPlanRow: (shopId: string) => Promise<ShopPlanRow | undefined>;
  /**
   * Upsert plan if observedAt is strictly newer than stored updated_at,
   * or row is missing. Equal timestamp: keep existing (no downgrade race).
   * Returns whether the row was written.
   */
  upsertPlan: (input: UpsertShopPlanInput) => Promise<{ applied: boolean; plan: UserPlan }>;
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

export function createShopPlanRepository(db: D1Database): ShopPlanRepository {
  async function getPlanRow(shopId: string): Promise<ShopPlanRow | undefined> {
    try {
      const raw = await db
        .prepare(`SELECT shop_id, plan, source, created_at, updated_at FROM shop_plans WHERE shop_id = ?`)
        .bind(shopId)
        .first<Record<string, unknown>>();
      if (!raw) return undefined;
      return {
        shop_id: String(raw.shop_id),
        plan: normalizeUserPlan(String(raw.plan)),
        source: raw.source == null ? null : String(raw.source),
        created_at: String(raw.created_at ?? ""),
        updated_at: String(raw.updated_at ?? ""),
      };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function getPlan(shopId: string): Promise<UserPlan> {
    const row = await getPlanRow(shopId);
    return row?.plan ?? "free";
  }

  async function upsertPlan(
    input: UpsertShopPlanInput,
  ): Promise<{ applied: boolean; plan: UserPlan }> {
    const plan = normalizeUserPlan(input.plan);
    const ts = input.observedAt || nowIso();
    const source = input.source || "runtime";

    try {
      await ensureShop(db, input.shopId, ts);

      const result = await db
        .prepare(
          `INSERT INTO shop_plans (
             shop_id, plan, source, migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, 'runtime', ?, ?, ?)
           ON CONFLICT(shop_id) DO UPDATE SET
             plan = excluded.plan,
             source = excluded.source,
             migration_source = excluded.migration_source,
             migration_version = excluded.migration_version,
             updated_at = excluded.updated_at
           WHERE excluded.updated_at > shop_plans.updated_at`,
        )
        .bind(input.shopId, plan, source, D1_MIGRATION_VERSION, ts, ts)
        .run();

      const applied = (result.meta?.changes ?? 0) > 0;
      const current = await getPlan(input.shopId);
      return { applied, plan: current };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  return { getPlan, getPlanRow, upsertPlan };
}
