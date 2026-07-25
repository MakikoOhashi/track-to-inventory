/**
 * Usage / plan D1 mode (Stage L5.3). Separate from SESSION_D1_MODE.
 *
 * redis    — Redis sole authority; no D1 usage/plan contact
 * shadow   — Redis primary; mirror reserve/refund/plan to D1; log diffs
 * d1_only  — D1 sole authority for usage/plan; Redis not contacted
 *
 * Unknown / empty → redis (fail closed; keep production Redis authority).
 */

export type UsageD1Mode = "redis" | "shadow" | "d1_only";

export function getUsageD1Mode(
  env: { USAGE_D1_MODE?: string } | NodeJS.ProcessEnv = process.env,
): UsageD1Mode {
  const raw = String(env.USAGE_D1_MODE || "redis")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (raw === "shadow") return "shadow";
  if (raw === "d1_only") return "d1_only";
  return "redis";
}

export function isUsageD1ShadowActive(
  env?: { USAGE_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  return getUsageD1Mode(env) === "shadow";
}

export function isUsageD1OnlyActive(
  env?: { USAGE_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  return getUsageD1Mode(env) === "d1_only";
}

/** D1 writes for usage/plan (shadow mirror or d1_only authority). */
export function isUsageD1WriteActive(
  env?: { USAGE_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  const mode = getUsageD1Mode(env);
  return mode === "shadow" || mode === "d1_only";
}
