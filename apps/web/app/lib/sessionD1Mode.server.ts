/**
 * Session D1 mode (Stage L4.2 / L4.3). Separate from D1_LEDGER_MODE.
 *
 * off        — no D1 session read/write/delete
 * shadow     — Redis primary; D1 shadow compare only (no D1 write/delete)
 * dual_write — Redis primary; after Redis store/delete success, mirror to D1;
 *              shadow compare also continues
 *
 * Unknown values and "primary" → off (fail closed; never accidental dual_write).
 */

export type SessionD1Mode = "off" | "shadow" | "dual_write";

export function getSessionD1Mode(
  env: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv = process.env,
): SessionD1Mode {
  const raw = String(env.SESSION_D1_MODE || "off")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (raw === "shadow") return "shadow";
  if (raw === "dual_write") return "dual_write";
  return "off";
}

/** Shadow compare runs in shadow and dual_write. */
export function isSessionD1ShadowActive(
  env?: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  const mode = getSessionD1Mode(env);
  return mode === "shadow" || mode === "dual_write";
}

/** D1 store/delete mirror only in dual_write. */
export function isSessionD1DualWriteActive(
  env?: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  return getSessionD1Mode(env) === "dual_write";
}
