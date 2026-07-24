import { createHash } from "node:crypto";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * Deterministic Shipment Key for Notion uniqueness (Stage J boundary).
 * Does not change Stage I item_key / idempotency_key rules.
 */
export function buildShipmentKey(shopId: string, siNumber: string): string {
  const shop = normalizeShopDomain(shopId);
  const si = typeof siNumber === "string" ? siNumber.trim() : "";
  if (!shop || !si) {
    throw new Error("shop_id and si_number are required for Shipment Key");
  }
  return createHash("sha256").update(`${shop}\n${si}`, "utf8").digest("hex");
}
