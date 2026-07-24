/**
 * Session D1 mode (Stage L4.2–L4.4a). Separate from D1_LEDGER_MODE.
 *
 * off         — no D1 session read/write/delete
 * shadow      — Redis primary; D1 shadow compare only (no D1 write/delete)
 * dual_write  — Redis primary read; Redis store/delete then D1 mirror; shadow continues
 * d1_primary  — D1 primary read with Redis fallback; Redis remains write primary + D1 mirror
 *
 * Bare "primary" / unknown → off (fail closed; never accidental dual_write or d1_primary).
 */

export type SessionD1Mode = "off" | "shadow" | "dual_write" | "d1_primary";

export function getSessionD1Mode(
  env: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv = process.env,
): SessionD1Mode {
  const raw = String(env.SESSION_D1_MODE || "off")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (raw === "shadow") return "shadow";
  if (raw === "dual_write") return "dual_write";
  if (raw === "d1_primary") return "d1_primary";
  return "off";
}

/** Shadow compare runs in shadow and dual_write only (not d1_primary). */
export function isSessionD1ShadowActive(
  env?: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  const mode = getSessionD1Mode(env);
  return mode === "shadow" || mode === "dual_write";
}

/** D1 store/delete mirror in dual_write and d1_primary. */
export function isSessionD1DualWriteActive(
  env?: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  const mode = getSessionD1Mode(env);
  return mode === "dual_write" || mode === "d1_primary";
}

export function isSessionD1PrimaryActive(
  env?: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  return getSessionD1Mode(env) === "d1_primary";
}
