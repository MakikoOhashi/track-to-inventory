/**
 * Idempotent Supabase → D1 shipments backfill helpers (Stage L9.1b).
 */

import type { ShipmentLineItem } from "~/lib/syncItemIdentity.server";
import { normalizeShopDomain } from "~/utils/shopDomain";
import { D1_MIGRATION_VERSION, nowIso } from "./client.server";
import {
  ShipmentItemValidationError,
  supabaseItemsToD1Rows,
  type D1ShipmentItemRow,
} from "./shipmentItemsCompat.server";
import type {
  ShipmentsRepository,
  SupabaseCompatibleShipment,
} from "./shipments.server";
import { createShipmentsRepository } from "./shipments.server";

/** Raw Supabase row as returned by PostgREST select('*'). */
export type SupabaseShipmentRow = {
  id: string;
  shop_id: string;
  si_number: string;
  status?: string | null;
  supplier_name?: string | null;
  transport_type?: string | null;
  memo?: string | null;
  etd?: string | null;
  eta?: string | null;
  clearance_date?: string | null;
  arrival_date?: string | null;
  delayed?: boolean | null;
  is_archived?: boolean | null;
  invoice_url?: string | null;
  pl_url?: string | null;
  si_url?: string | null;
  other_url?: string | null;
  items?: ShipmentLineItem[] | null;
};

export type BackfillValidationResult =
  | { ok: true; itemRows: D1ShipmentItemRow[]; shipmentId: string; shopId: string; siNumber: string }
  | { ok: false; error: ShipmentItemValidationError | Error };

const BACKFILL_PARSE = { strictUnknownKeys: true } as const;

function emptyToNull(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

function rowToCreateInput(
  row: SupabaseShipmentRow,
  parseOptions: { strictUnknownKeys?: boolean } = BACKFILL_PARSE,
) {
  return {
    id: row.id.trim(),
    si_number: row.si_number.trim(),
    status: row.status ?? undefined,
    supplier_name: emptyToNull(row.supplier_name),
    transport_type: emptyToNull(row.transport_type),
    memo: emptyToNull(row.memo),
    etd: emptyToNull(row.etd),
    eta: emptyToNull(row.eta),
    clearance_date: emptyToNull(row.clearance_date),
    arrival_date: emptyToNull(row.arrival_date),
    delayed: row.delayed ?? undefined,
    is_archived: row.is_archived ?? undefined,
    invoice_url: emptyToNull(row.invoice_url),
    pl_url: emptyToNull(row.pl_url),
    si_url: emptyToNull(row.si_url),
    other_url: emptyToNull(row.other_url),
    items: row.items ?? [],
    parseOptions,
  };
}

/** Runtime shadow mirror input (non-strict item keys). */
export function supabaseRowToRepoInput(row: SupabaseShipmentRow) {
  return rowToCreateInput(row, { strictUnknownKeys: false });
}

/** Mirror one Supabase row to D1 after primary mutation success (L9.3). */
export async function mirrorSupabaseRowToD1(
  db: D1Database,
  row: SupabaseShipmentRow,
): Promise<{ action: "inserted" | "updated"; itemCount: number }> {
  const repo = createShipmentsRepository(db);
  const shopId = normalizeShopDomain(row.shop_id);
  const siNumber = row.si_number.trim();
  if (!shopId || !siNumber) throw new Error("Invalid shipment row for mirror");

  const input = supabaseRowToRepoInput(row);
  const existing =
    (await repo.getByShopAndSi(shopId, siNumber)) ||
    (input.id ? await repo.getById(shopId, input.id) : undefined);

  if (existing) {
    const { id: _id, si_number, ...updateFields } = input;
    const updated = await repo.update(shopId, existing.si_number, {
      ...updateFields,
      si_number,
    });
    if (!updated) throw new Error("Mirror update failed");
    return { action: "updated", itemCount: updated.items.length };
  }

  const created = await repo.create(shopId, input);
  return { action: "inserted", itemCount: created.items.length };
}

/** Delete one shipment in D1 (shop boundary enforced by repository). */
export async function mirrorDeleteShipmentOnD1(
  db: D1Database,
  shopId: string,
  siNumber: string,
): Promise<boolean> {
  return createShipmentsRepository(db).delete(shopId, siNumber);
}

/** Delete all shipments for a shop in D1 (uninstall mirror). */
export async function mirrorDeleteAllShipmentsOnD1(
  db: D1Database,
  shopId: string,
): Promise<number> {
  return createShipmentsRepository(db).deleteAllByShop(shopId);
}

/** Validate items and build deterministic D1 item rows (strict unknown keys). */
export function validateSupabaseItemsForBackfill(params: {
  row: SupabaseShipmentRow;
}): BackfillValidationResult {
  const shopId = normalizeShopDomain(params.row.shop_id);
  const siNumber = typeof params.row.si_number === "string" ? params.row.si_number.trim() : "";
  const shipmentId = typeof params.row.id === "string" ? params.row.id.trim() : "";

  if (!shopId || !siNumber || !shipmentId) {
    return {
      ok: false,
      error: new Error("Invalid shipment row: shop_id, si_number, or id missing"),
    };
  }

  try {
    const itemRows = supabaseItemsToD1Rows({
      items: params.row.items,
      shipmentId,
      shopId,
      siNumber,
      now: nowIso(),
      migrationVersion: D1_MIGRATION_VERSION,
      parseOptions: BACKFILL_PARSE,
    });
    return { ok: true, itemRows, shipmentId, shopId, siNumber };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ShipmentItemValidationError
          ? error
          : error instanceof Error
            ? error
            : new Error(String(error)),
    };
  }
}

export type BackfillUpsertResult = {
  action: "inserted" | "updated";
  shipment: SupabaseCompatibleShipment;
  itemCount: number;
};

export type ShipmentsBackfillRepository = ShipmentsRepository & {
  upsertFromSupabaseBackfill: (
    row: SupabaseShipmentRow,
    options?: { dryRun?: boolean },
  ) => Promise<BackfillUpsertResult>;
};

/** Attach idempotent backfill upsert to an existing repository instance. */
export function withBackfillUpsert(repo: ShipmentsRepository): ShipmentsBackfillRepository {
  return {
    ...repo,
    async upsertFromSupabaseBackfill(row, options) {
      const validated = validateSupabaseItemsForBackfill({ row });
      if (!validated.ok) {
        throw validated.error;
      }

      if (options?.dryRun) {
        return {
          action: "inserted",
          shipment: {
            id: validated.shipmentId,
            shop_id: validated.shopId,
            si_number: validated.siNumber,
            status: row.status ?? "SI発行済",
            supplier_name: emptyToNull(row.supplier_name),
            transport_type: emptyToNull(row.transport_type),
            memo: emptyToNull(row.memo),
            etd: emptyToNull(row.etd),
            eta: emptyToNull(row.eta),
            clearance_date: emptyToNull(row.clearance_date),
            arrival_date: emptyToNull(row.arrival_date),
            delayed: Boolean(row.delayed),
            is_archived: Boolean(row.is_archived),
            invoice_url: emptyToNull(row.invoice_url),
            pl_url: emptyToNull(row.pl_url),
            si_url: emptyToNull(row.si_url),
            other_url: emptyToNull(row.other_url),
            items: row.items ?? [],
          },
          itemCount: validated.itemRows.length,
        };
      }

      const existing = await repo.getByShopAndSi(validated.shopId, validated.siNumber);
      const input = rowToCreateInput(row);

      if (existing) {
        const { id: _id, si_number, ...updateFields } = input;
        const updated = await repo.update(validated.shopId, si_number, updateFields);
        if (!updated) throw new Error("Backfill update failed");
        return { action: "updated", shipment: updated, itemCount: updated.items.length };
      }

      const created = await repo.create(validated.shopId, input);
      return { action: "inserted", shipment: created, itemCount: created.items.length };
    },
  };
}
