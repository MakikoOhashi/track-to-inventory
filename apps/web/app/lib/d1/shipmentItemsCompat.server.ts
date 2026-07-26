/**
 * Supabase shipments.items JSON ↔ D1 shipment_items (Stage L9.1 / L9.1b).
 *
 * Item identity (`shipment_items.id`):
 * - If Supabase `sync_item_id` is present → use verbatim.
 * - Otherwise → deterministic SHA-256 from shipment scope + array index + business fields.
 *
 * Reorder policy (L9.1b):
 * - Array index is part of the deterministic ID material.
 * - Reordering items changes index → new IDs → treated as identity change (not an in-place move).
 * - To preserve identity across reorder, every line must carry an explicit `sync_item_id`.
 */

import { createHash } from "node:crypto";
import type { ShipmentLineItem } from "~/lib/syncItemIdentity.server";

export type D1ShipmentItemRow = {
  id: string;
  shipment_id: string;
  shop_id: string;
  si_number: string;
  name: string | null;
  product_code: string | null;
  quantity: number | null;
  unit_price: string | null;
  variant_id: string | null;
  sort_order: number;
  migration_source: string | null;
  migration_version: string | null;
  created_at: string;
  updated_at: string;
};

/** Keys copied from Supabase items JSON. Any other key fails strict validation (backfill). */
export const KNOWN_SUPABASE_ITEM_KEYS = [
  "sync_item_id",
  "name",
  "quantity",
  "product_code",
  "unit_price",
  "variant_id",
] as const;

export type KnownSupabaseItemKey = (typeof KNOWN_SUPABASE_ITEM_KEYS)[number];

export class ShipmentItemValidationError extends Error {
  readonly code: string;
  readonly index: number;

  constructor(code: string, message: string, index: number) {
    super(message);
    this.name = "ShipmentItemValidationError";
    this.code = code;
    this.index = index;
  }
}

export type ParsedSupabaseItemFields = {
  name: string | null;
  product_code: string | null;
  quantity: number | null;
  unit_price: string | null;
  variant_id: string | null;
};

export type ItemIdentityContext = {
  shipmentId: string;
  shopId: string;
  siNumber: string;
  index: number;
};

export type SupabaseItemsParseOptions = {
  /** Backfill dry-run: reject unknown item keys instead of ignoring them. */
  strictUnknownKeys?: boolean;
};

function assertPlainObject(value: unknown, index: number): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShipmentItemValidationError(
      "INVALID_ITEM_SHAPE",
      `items[${index}] must be an object`,
      index,
    );
  }
  return value as Record<string, unknown>;
}

function normalizeOptionalText(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

/**
 * Parse quantity: null/empty allowed; finite numbers and numeric strings allowed;
 * non-numeric values are errors (never silently coerced to null).
 */
export function parseItemQuantity(value: unknown, index: number): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ShipmentItemValidationError(
        "INVALID_QUANTITY",
        `items[${index}].quantity is not a finite number`,
        index,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new ShipmentItemValidationError(
        "INVALID_QUANTITY",
        `items[${index}].quantity is not numeric: ${JSON.stringify(value)}`,
        index,
      );
    }
    return n;
  }
  throw new ShipmentItemValidationError(
    "INVALID_QUANTITY",
    `items[${index}].quantity has unsupported type`,
    index,
  );
}

export function collectUnknownItemKeys(raw: Record<string, unknown>): string[] {
  const known = new Set<string>(KNOWN_SUPABASE_ITEM_KEYS);
  return Object.keys(raw)
    .filter((k) => !known.has(k))
    .sort();
}

/** Parse one Supabase item object into normalized business fields. */
export function parseSupabaseItemFields(
  item: ShipmentLineItem | Record<string, unknown>,
  index: number,
  options?: SupabaseItemsParseOptions,
): ParsedSupabaseItemFields {
  const raw = assertPlainObject(item, index);
  const unknown = collectUnknownItemKeys(raw);
  if (unknown.length > 0 && options?.strictUnknownKeys) {
    throw new ShipmentItemValidationError(
      "UNKNOWN_ITEM_KEYS",
      `items[${index}] has unknown keys: ${unknown.join(", ")}`,
      index,
    );
  }

  const name =
    raw.name == null || raw.name === ""
      ? null
      : typeof raw.name === "string"
        ? raw.name
        : String(raw.name);

  return {
    name,
    product_code: normalizeOptionalText(raw.product_code),
    quantity: parseItemQuantity(raw.quantity, index),
    unit_price: normalizeOptionalText(raw.unit_price),
    variant_id:
      typeof raw.variant_id === "string" && raw.variant_id.trim()
        ? raw.variant_id.trim()
        : null,
  };
}

/** Deterministic fallback ID when sync_item_id is absent (stable across re-runs). */
export function buildDeterministicItemId(
  ctx: ItemIdentityContext,
  fields: ParsedSupabaseItemFields,
): string {
  const material = [
    ctx.shipmentId,
    ctx.shopId,
    ctx.siNumber,
    String(ctx.index),
    fields.name ?? "",
    fields.product_code ?? "",
    fields.quantity == null ? "" : String(fields.quantity),
    fields.unit_price ?? "",
    fields.variant_id ?? "",
  ].join("\n");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** Resolve D1 row id: explicit sync_item_id wins; else deterministic hash. */
export function resolveShipmentItemId(
  item: ShipmentLineItem | Record<string, unknown>,
  ctx: ItemIdentityContext,
  fields: ParsedSupabaseItemFields,
): string {
  const raw = item as ShipmentLineItem;
  if (typeof raw.sync_item_id === "string" && raw.sync_item_id.trim()) {
    return raw.sync_item_id.trim();
  }
  return buildDeterministicItemId(ctx, fields);
}

/** Supabase items JSON → D1 rows (shared by create / update / backfill). */
export function supabaseItemsToD1Rows(params: {
  items: ShipmentLineItem[] | null | undefined;
  shipmentId: string;
  shopId: string;
  siNumber: string;
  now: string;
  migrationVersion: string;
  parseOptions?: SupabaseItemsParseOptions;
}): D1ShipmentItemRow[] {
  const list = Array.isArray(params.items) ? params.items : [];
  const ids = new Set<string>();

  return list.map((item, index) => {
    const fields = parseSupabaseItemFields(item, index, params.parseOptions);
    const id = resolveShipmentItemId(item, {
      shipmentId: params.shipmentId,
      shopId: params.shopId,
      siNumber: params.siNumber,
      index,
    }, fields);

    if (ids.has(id)) {
      throw new ShipmentItemValidationError(
        "DUPLICATE_ITEM_ID",
        `duplicate shipment_items.id within shipment at index ${index}: ${id}`,
        index,
      );
    }
    ids.add(id);

    return {
      id,
      shipment_id: params.shipmentId,
      shop_id: params.shopId,
      si_number: params.siNumber,
      name: fields.name,
      product_code: fields.product_code,
      quantity: fields.quantity,
      unit_price: fields.unit_price,
      variant_id: fields.variant_id,
      sort_order: index,
      migration_source: "runtime",
      migration_version: params.migrationVersion,
      created_at: params.now,
      updated_at: params.now,
    };
  });
}

/** D1 rows → Supabase-compatible items JSON (sync-stock fields retained). */
export function d1RowsToSupabaseItems(rows: D1ShipmentItemRow[]): ShipmentLineItem[] {
  const sorted = [...rows].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );
  return sorted.map((row) => {
    const item: ShipmentLineItem = {
      sync_item_id: row.id,
    };
    if (row.name != null) item.name = row.name;
    if (row.quantity != null) item.quantity = row.quantity;
    if (row.product_code != null) item.product_code = row.product_code;
    if (row.unit_price != null) item.unit_price = row.unit_price;
    if (row.variant_id != null) item.variant_id = row.variant_id;
    return item;
  });
}

/** Stable fingerprint for idempotency tests (ignores timestamps). */
export function fingerprintD1ItemRows(rows: D1ShipmentItemRow[]): string[] {
  return [...rows]
    .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    .map(
      (r) =>
        `${r.id}|${r.sort_order}|${r.name ?? ""}|${r.product_code ?? ""}|${r.quantity ?? ""}|${r.unit_price ?? ""}|${r.variant_id ?? ""}`,
    );
}

/** @deprecated use parseItemQuantity — kept for importers expecting old name */
export function normalizeItemQuantity(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @deprecated use resolveShipmentItemId via supabaseItemsToD1Rows */
export function resolveSyncItemId(item: ShipmentLineItem): string {
  const fields = parseSupabaseItemFields(item, 0, { strictUnknownKeys: false });
  return resolveShipmentItemId(
    item,
    {
      shipmentId: "legacy",
      shopId: "legacy",
      siNumber: "legacy",
      index: 0,
    },
    fields,
  );
}
