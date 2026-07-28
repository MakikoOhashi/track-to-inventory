/**
 * Plan limits and period helpers (Stage L5.1).
 * Pure module shared by the D1 usage service.
 *
 * period_ym: UTC YYYY-MM.
 */

export type UserPlan = "free" | "basic" | "pro";

export type UsageKind = "ai" | "ocr" | "delete";

/** Usage limits (+ delete=2 from api.delete-shipment). */
export const PLAN_LIMITS: Record<
  UserPlan,
  { ai: number; ocr: number; delete: number }
> = {
  free: { ai: 5, ocr: 3, delete: 2 },
  basic: { ai: 50, ocr: 20, delete: 2 },
  pro: { ai: Number.POSITIVE_INFINITY, ocr: Number.POSITIVE_INFINITY, delete: 2 },
};

export function normalizeUserPlan(raw: string | null | undefined): UserPlan {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (v === "basic" || v === "pro" || v === "free") return v;
  return "free";
}

/** UTC calendar month as YYYY-MM. */
export function utcPeriodYm(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function limitFor(plan: UserPlan, kind: UsageKind): number {
  return PLAN_LIMITS[plan][kind];
}
