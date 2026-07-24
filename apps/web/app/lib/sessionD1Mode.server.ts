/**
 * Session D1 mode (Stage L4.2). Separate from D1_LEDGER_MODE.
 *
 * off    — no D1 session calls
 * shadow — compare only; Redis remains sole session authority
 * primary — not accepted yet (treated as off)
 */

export type SessionD1Mode = "off" | "shadow";

export function getSessionD1Mode(
  env: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv = process.env,
): SessionD1Mode {
  const raw = String(env.SESSION_D1_MODE || "off")
    .trim()
    .toLowerCase();
  if (raw === "shadow") return "shadow";
  // primary / unknown / empty → off (fail closed for authority)
  return "off";
}

export function isSessionD1ShadowActive(
  env?: { SESSION_D1_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  return getSessionD1Mode(env) === "shadow";
}
