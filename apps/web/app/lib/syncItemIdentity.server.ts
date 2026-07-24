import { createHash, randomUUID } from "node:crypto";

export type ShipmentLineItem = {
  sync_item_id?: string;
  name?: string;
  quantity?: unknown;
  variant_id?: string;
  product_code?: string | null;
  unit_price?: string | null;
  [key: string]: unknown;
};

/** Stable per-line id. Never use array index alone. */
export function ensureSyncItemId(item: ShipmentLineItem): string {
  if (typeof item.sync_item_id === "string" && item.sync_item_id.trim()) {
    return item.sync_item_id.trim();
  }
  const id = randomUUID();
  item.sync_item_id = id;
  return id;
}

/**
 * Deterministic server-side idempotency key.
 * Same shop/SI/item/variant/delta → same key (safe re-run).
 * Quantity/delta change → new key (legitimate new sync).
 */
export function buildSyncIdempotencyKey(params: {
  shop: string;
  siNumber: string;
  itemKey: string;
  variantId: string;
  deltaQuantity: number;
}): string {
  const material = [
    params.shop,
    params.siNumber,
    params.itemKey,
    params.variantId,
    String(params.deltaQuantity),
  ].join("|");
  return createHash("sha256").update(material).digest("hex");
}

export function normalizeDeltaQuantity(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
