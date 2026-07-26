/**
 * D1 shipments mode (Stage L9.4).
 *
 * off    — no D1 shipments shadow
 * shadow — Supabase primary; read compare + write mirror after Supabase success
 * d1     — D1 reads for explicitly allowlisted shops; writes remain separate
 */
import { normalizeShopDomain } from "~/utils/shopDomain";

export type D1ShipmentsMode = "off" | "shadow" | "d1";
export type D1ShipmentsReadMode = "supabase" | "d1";
export type D1ShipmentsWriteMode = "off" | "shadow";
type ShipmentsModeEnv = {
  D1_SHIPMENTS_MODE?: string;
  D1_SHIPMENTS_READ_MODE?: string;
  D1_SHIPMENTS_READ_SHOP_ALLOWLIST?: string;
  D1_SHIPMENTS_WRITE_MODE?: string;
};

export function getD1ShipmentsMode(
  env: { D1_SHIPMENTS_MODE?: string } | NodeJS.ProcessEnv = process.env,
): D1ShipmentsMode {
  const raw = String(env.D1_SHIPMENTS_MODE || "off")
    .trim()
    .toLowerCase();
  if (raw === "shadow" || raw === "d1" || raw === "off") return raw;
  return "off";
}

export function isD1ShipmentsShadowActive(
  env: ShipmentsModeEnv | NodeJS.ProcessEnv = process.env,
): boolean {
  return getD1ShipmentsWriteMode(env) === "shadow";
}

export function getD1ShipmentsReadMode(
  env: ShipmentsModeEnv | NodeJS.ProcessEnv = process.env,
): D1ShipmentsReadMode {
  const raw = String(env.D1_SHIPMENTS_READ_MODE || "")
    .trim()
    .toLowerCase();
  return raw === "d1" ? "d1" : "supabase";
}

export function getD1ShipmentsReadShopAllowlist(
  env: ShipmentsModeEnv | NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const shops = String(env.D1_SHIPMENTS_READ_SHOP_ALLOWLIST || "")
    .split(",")
    .map((entry) => normalizeShopDomain(entry))
    .filter(Boolean);
  return new Set(shops);
}

export function isD1ShipmentsReadEnabledForShop(
  shopId: string,
  env: ShipmentsModeEnv | NodeJS.ProcessEnv = process.env,
): boolean {
  if (getD1ShipmentsReadMode(env) !== "d1") return false;
  const shop = normalizeShopDomain(shopId);
  return shop.length > 0 && getD1ShipmentsReadShopAllowlist(env).has(shop);
}

export function getD1ShipmentsWriteMode(
  env: ShipmentsModeEnv | NodeJS.ProcessEnv = process.env,
): D1ShipmentsWriteMode {
  const explicit = String(env.D1_SHIPMENTS_WRITE_MODE || "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit === "shadow" ? "shadow" : "off";

  const legacy = getD1ShipmentsMode(env);
  // Legacy d1 previously disabled shadow without enabling primary. Preserve data
  // propagation until an explicit write mode is configured.
  return legacy === "shadow" || legacy === "d1" ? "shadow" : "off";
}

export function isD1ShipmentsPrimaryEnabled(
  env: ShipmentsModeEnv | NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    getD1ShipmentsReadMode(env) === "d1" &&
    getD1ShipmentsReadShopAllowlist(env).size > 0
  );
}
