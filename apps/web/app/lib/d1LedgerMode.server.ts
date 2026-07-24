/**
 * D1 ledger mode (Stage L2). Separate from Redis INVSYNC_LEDGER_MODE.
 *
 * off     — no D1 ledger calls
 * shadow  — compare/record only; never authorizes Shopify mutation
 * primary — parsed but NOT enabled as mutation authority in L2
 */

export type D1LedgerMode = "off" | "shadow" | "primary";

export function getD1LedgerMode(
  env: { D1_LEDGER_MODE?: string } | NodeJS.ProcessEnv = process.env,
): D1LedgerMode {
  const raw = String(env.D1_LEDGER_MODE || "off")
    .trim()
    .toLowerCase();
  if (raw === "shadow" || raw === "primary" || raw === "off") return raw;
  return "off";
}

/** L2: D1 never authorizes mutation, even if mode=primary. */
export function isD1LedgerShadowActive(
  env?: { D1_LEDGER_MODE?: string } | NodeJS.ProcessEnv,
): boolean {
  const mode = getD1LedgerMode(env);
  return mode === "shadow" || mode === "primary";
}

export function isD1LedgerPrimaryEnabled(): boolean {
  // Intentionally false until a future Stage explicitly enables cutover.
  return false;
}
