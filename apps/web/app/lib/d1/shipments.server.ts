/**
 * Shipments repository for D1 (Stage L9.1).
 * Supabase-compatible row shape at the boundary; not wired into routes yet.
 */

import { randomUUID } from "node:crypto";
import type { ShipmentLineItem } from "~/lib/syncItemIdentity.server";
import { normalizeShopDomain } from "~/utils/shopDomain";
import { classifyD1Error } from "./errors.server";
import { D1_MIGRATION_VERSION, nowIso } from "./client.server";
import {
  d1RowsToSupabaseItems,
  supabaseItemsToD1Rows,
  type D1ShipmentItemRow,
  type SupabaseItemsParseOptions,
} from "./shipmentItemsCompat.server";

type RawRow = Record<string, unknown>;

/** Supabase `shipments` row shape returned to callers (JSON API compatible). */
export type SupabaseCompatibleShipment = {
  id: string;
  shop_id: string;
  si_number: string;
  status: string;
  supplier_name: string | null;
  transport_type: string | null;
  memo: string | null;
  etd: string | null;
  eta: string | null;
  clearance_date: string | null;
  arrival_date: string | null;
  delayed: boolean;
  is_archived: boolean;
  invoice_url: string | null;
  pl_url: string | null;
  si_url: string | null;
  other_url: string | null;
  items: ShipmentLineItem[];
};

export type ShipmentCreateInput = {
  id?: string;
  si_number: string;
  status?: string;
  supplier_name?: string | null;
  transport_type?: string | null;
  memo?: string | null;
  etd?: string | null;
  eta?: string | null;
  clearance_date?: string | null;
  arrival_date?: string | null;
  delayed?: boolean;
  is_archived?: boolean;
  invoice_url?: string | null;
  pl_url?: string | null;
  si_url?: string | null;
  other_url?: string | null;
  items?: ShipmentLineItem[] | null;
  parseOptions?: SupabaseItemsParseOptions;
};

export type ShipmentUpdateInput = Partial<
  Omit<ShipmentCreateInput, "si_number">
> & {
  si_number?: string;
  items?: ShipmentLineItem[] | null;
  parseOptions?: SupabaseItemsParseOptions;
};

export class ShipmentDuplicateError extends Error {
  readonly code = "DUPLICATE_SI" as const;
  constructor(shopId: string, siNumber: string) {
    super(`Shipment already exists: ${shopId} / ${siNumber}`);
    this.name = "ShipmentDuplicateError";
  }
}

function emptyToNull(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

function cleanDateField(value: unknown): string | null {
  if (value === "" || value == null || value === undefined) return null;
  return String(value);
}

function boolFromD1(value: unknown): boolean {
  return Number(value ?? 0) === 1;
}

function boolToD1(value: boolean | undefined, defaultValue: boolean): number {
  const v = value ?? defaultValue;
  return v ? 1 : 0;
}

function mapShipmentRow(
  raw: RawRow | null | undefined,
): Omit<SupabaseCompatibleShipment, "items"> | undefined {
  if (!raw) return undefined;
  const shop = normalizeShopDomain(String(raw.shop_id ?? ""));
  if (!shop) return undefined;
  return {
    id: String(raw.id ?? ""),
    shop_id: shop,
    si_number: String(raw.si_number ?? ""),
    status: String(raw.status ?? ""),
    supplier_name: emptyToNull(raw.supplier_name),
    transport_type: emptyToNull(raw.transport_type),
    memo: emptyToNull(raw.memo),
    etd: emptyToNull(raw.etd),
    eta: emptyToNull(raw.eta),
    clearance_date: emptyToNull(raw.clearance_date),
    arrival_date: emptyToNull(raw.arrival_date),
    delayed: boolFromD1(raw.delayed),
    is_archived: boolFromD1(raw.is_archived),
    invoice_url: emptyToNull(raw.invoice_url),
    pl_url: emptyToNull(raw.pl_url),
    si_url: emptyToNull(raw.si_url),
    other_url: emptyToNull(raw.other_url),
  };
}

function mapItemRow(raw: RawRow): D1ShipmentItemRow {
  return {
    id: String(raw.id ?? ""),
    shipment_id: String(raw.shipment_id ?? ""),
    shop_id: String(raw.shop_id ?? ""),
    si_number: String(raw.si_number ?? ""),
    name: emptyToNull(raw.name),
    product_code: emptyToNull(raw.product_code),
    quantity: raw.quantity == null ? null : Number(raw.quantity),
    unit_price: emptyToNull(raw.unit_price),
    variant_id: emptyToNull(raw.variant_id),
    sort_order: Number(raw.sort_order ?? 0),
    migration_source: emptyToNull(raw.migration_source),
    migration_version: emptyToNull(raw.migration_version),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  };
}

async function loadItemsForShipment(
  db: D1Database,
  shipmentId: string,
  shopId: string,
): Promise<D1ShipmentItemRow[]> {
  const result = await db
    .prepare(
      `SELECT id, shipment_id, shop_id, si_number, name, product_code, quantity,
              unit_price, variant_id, sort_order, migration_source, migration_version,
              created_at, updated_at
       FROM shipment_items
       WHERE shipment_id = ? AND shop_id = ?
       ORDER BY sort_order ASC, id ASC`,
    )
    .bind(shipmentId, shopId)
    .all<RawRow>();
  return (result.results ?? []).map(mapItemRow);
}

async function composeShipment(
  db: D1Database,
  raw: RawRow | null | undefined,
): Promise<SupabaseCompatibleShipment | undefined> {
  const base = mapShipmentRow(raw);
  if (!base || !base.id) return undefined;
  const items = await loadItemsForShipment(db, base.id, base.shop_id);
  return {
    ...base,
    items: d1RowsToSupabaseItems(items),
  };
}

async function ensureShopRow(db: D1Database, shopId: string, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO shops (
         shop_id, migration_source, migration_version, created_at, updated_at
       ) VALUES (?, 'runtime', ?, ?, ?)`,
    )
    .bind(shopId, D1_MIGRATION_VERSION, now, now)
    .run();
}

function isUniqueViolation(error: unknown): boolean {
  const classified = classifyD1Error(error);
  return classified.classification === "constraint";
}

export type ShipmentsRepository = {
  listByShop: (shopId: string) => Promise<SupabaseCompatibleShipment[]>;
  getById: (shopId: string, id: string) => Promise<SupabaseCompatibleShipment | undefined>;
  getByShopAndSi: (
    shopId: string,
    siNumber: string,
  ) => Promise<SupabaseCompatibleShipment | undefined>;
  create: (shopId: string, input: ShipmentCreateInput) => Promise<SupabaseCompatibleShipment>;
  update: (
    shopId: string,
    siNumber: string,
    input: ShipmentUpdateInput,
  ) => Promise<SupabaseCompatibleShipment | undefined>;
  delete: (shopId: string, siNumber: string) => Promise<boolean>;
  countByShop: (shopId: string) => Promise<number>;
  deleteAllByShop: (shopId: string) => Promise<number>;
};

export function createShipmentsRepository(db: D1Database): ShipmentsRepository {
  return {
    async listByShop(shopId) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) return [];
      const rows = await db
        .prepare(
          `SELECT id, shop_id, si_number, status, supplier_name, transport_type, memo,
                  etd, eta, clearance_date, arrival_date, delayed, is_archived,
                  invoice_url, pl_url, si_url, other_url
           FROM shipments
           WHERE shop_id = ?
           ORDER BY si_number ASC`,
        )
        .bind(shop)
        .all<RawRow>();
      const out: SupabaseCompatibleShipment[] = [];
      for (const raw of rows.results ?? []) {
        const composed = await composeShipment(db, raw);
        if (composed) out.push(composed);
      }
      return out;
    },

    async getById(shopId, id) {
      const shop = normalizeShopDomain(shopId);
      if (!shop || !id.trim()) return undefined;
      const raw = await db
        .prepare(
          `SELECT id, shop_id, si_number, status, supplier_name, transport_type, memo,
                  etd, eta, clearance_date, arrival_date, delayed, is_archived,
                  invoice_url, pl_url, si_url, other_url
           FROM shipments
           WHERE id = ? AND shop_id = ?`,
        )
        .bind(id.trim(), shop)
        .first<RawRow>();
      return composeShipment(db, raw ?? undefined);
    },

    async getByShopAndSi(shopId, siNumber) {
      const shop = normalizeShopDomain(shopId);
      const si = siNumber.trim();
      if (!shop || !si) return undefined;
      const raw = await db
        .prepare(
          `SELECT id, shop_id, si_number, status, supplier_name, transport_type, memo,
                  etd, eta, clearance_date, arrival_date, delayed, is_archived,
                  invoice_url, pl_url, si_url, other_url
           FROM shipments
           WHERE shop_id = ? AND si_number = ?`,
        )
        .bind(shop, si)
        .first<RawRow>();
      return composeShipment(db, raw ?? undefined);
    },

    async create(shopId, input) {
      const shop = normalizeShopDomain(shopId);
      const si = input.si_number?.trim();
      if (!shop || !si) throw new Error("Invalid shop_id or si_number");

      const now = nowIso();
      await ensureShopRow(db, shop, now);

      const id = input.id?.trim() || randomUUID();
      const itemRows = supabaseItemsToD1Rows({
        items: input.items,
        shipmentId: id,
        shopId: shop,
        siNumber: si,
        now,
        migrationVersion: D1_MIGRATION_VERSION,
        parseOptions: input.parseOptions,
      });

      const statements = [
        db.prepare(
          `INSERT INTO shipments (
             id, shop_id, si_number, status, supplier_name, transport_type, memo,
             etd, eta, clearance_date, arrival_date, delayed, is_archived,
             invoice_url, pl_url, si_url, other_url, version,
             migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'runtime', ?, ?, ?)`,
        ).bind(
          id,
          shop,
          si,
          input.status ?? "SI発行済",
          emptyToNull(input.supplier_name),
          emptyToNull(input.transport_type),
          emptyToNull(input.memo),
          cleanDateField(input.etd),
          cleanDateField(input.eta),
          cleanDateField(input.clearance_date),
          cleanDateField(input.arrival_date),
          boolToD1(input.delayed, false),
          boolToD1(input.is_archived, false),
          emptyToNull(input.invoice_url),
          emptyToNull(input.pl_url),
          emptyToNull(input.si_url),
          emptyToNull(input.other_url),
          D1_MIGRATION_VERSION,
          now,
          now,
        ),
        ...itemRows.map((row) =>
          db.prepare(
            `INSERT INTO shipment_items (
               id, shipment_id, shop_id, si_number, name, product_code, quantity,
               unit_price, variant_id, sort_order,
               migration_source, migration_version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            row.id,
            row.shipment_id,
            row.shop_id,
            row.si_number,
            row.name,
            row.product_code,
            row.quantity,
            row.unit_price,
            row.variant_id,
            row.sort_order,
            row.migration_source,
            row.migration_version,
            row.created_at,
            row.updated_at,
          ),
        ),
      ];

      try {
        await db.batch(statements);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ShipmentDuplicateError(shop, si);
        }
        throw error;
      }

      const created = await composeShipment(
        db,
        await db
          .prepare(
            `SELECT id, shop_id, si_number, status, supplier_name, transport_type, memo,
                    etd, eta, clearance_date, arrival_date, delayed, is_archived,
                    invoice_url, pl_url, si_url, other_url
             FROM shipments WHERE id = ? AND shop_id = ?`,
          )
          .bind(id, shop)
          .first<RawRow>(),
      );
      if (!created) throw new Error("Failed to load created shipment");
      return created;
    },

    async update(shopId, siNumber, input) {
      const shop = normalizeShopDomain(shopId);
      const si = siNumber.trim();
      if (!shop || !si) return undefined;

      const existing = await db
        .prepare(
          `SELECT id, shop_id, si_number, status, supplier_name, transport_type, memo,
                  etd, eta, clearance_date, arrival_date, delayed, is_archived,
                  invoice_url, pl_url, si_url, other_url, version
           FROM shipments
           WHERE shop_id = ? AND si_number = ?`,
        )
        .bind(shop, si)
        .first<RawRow>();
      if (!existing) return undefined;

      const shipmentId = String(existing.id);
      const now = nowIso();
      const nextSi =
        typeof input.si_number === "string" && input.si_number.trim()
          ? input.si_number.trim()
          : si;

      const merged = {
        status: input.status ?? String(existing.status ?? "SI発行済"),
        supplier_name:
          input.supplier_name !== undefined
            ? emptyToNull(input.supplier_name)
            : emptyToNull(existing.supplier_name),
        transport_type:
          input.transport_type !== undefined
            ? emptyToNull(input.transport_type)
            : emptyToNull(existing.transport_type),
        memo:
          input.memo !== undefined ? emptyToNull(input.memo) : emptyToNull(existing.memo),
        etd:
          input.etd !== undefined
            ? cleanDateField(input.etd)
            : emptyToNull(existing.etd),
        eta:
          input.eta !== undefined
            ? cleanDateField(input.eta)
            : emptyToNull(existing.eta),
        clearance_date:
          input.clearance_date !== undefined
            ? cleanDateField(input.clearance_date)
            : emptyToNull(existing.clearance_date),
        arrival_date:
          input.arrival_date !== undefined
            ? cleanDateField(input.arrival_date)
            : emptyToNull(existing.arrival_date),
        delayed:
          input.delayed !== undefined
            ? boolToD1(input.delayed, false)
            : Number(existing.delayed ?? 0),
        is_archived:
          input.is_archived !== undefined
            ? boolToD1(input.is_archived, false)
            : Number(existing.is_archived ?? 0),
        invoice_url:
          input.invoice_url !== undefined
            ? emptyToNull(input.invoice_url)
            : emptyToNull(existing.invoice_url),
        pl_url:
          input.pl_url !== undefined ? emptyToNull(input.pl_url) : emptyToNull(existing.pl_url),
        si_url:
          input.si_url !== undefined ? emptyToNull(input.si_url) : emptyToNull(existing.si_url),
        other_url:
          input.other_url !== undefined
            ? emptyToNull(input.other_url)
            : emptyToNull(existing.other_url),
      };

      const statements: D1PreparedStatement[] = [
        db.prepare(
          `UPDATE shipments SET
             si_number = ?,
             status = ?,
             supplier_name = ?,
             transport_type = ?,
             memo = ?,
             etd = ?,
             eta = ?,
             clearance_date = ?,
             arrival_date = ?,
             delayed = ?,
             is_archived = ?,
             invoice_url = ?,
             pl_url = ?,
             si_url = ?,
             other_url = ?,
             version = version + 1,
             updated_at = ?,
             migration_source = 'runtime',
             migration_version = ?
           WHERE id = ? AND shop_id = ?`,
        ).bind(
          nextSi,
          merged.status,
          merged.supplier_name,
          merged.transport_type,
          merged.memo,
          merged.etd,
          merged.eta,
          merged.clearance_date,
          merged.arrival_date,
          merged.delayed,
          merged.is_archived,
          merged.invoice_url,
          merged.pl_url,
          merged.si_url,
          merged.other_url,
          now,
          D1_MIGRATION_VERSION,
          shipmentId,
          shop,
        ),
      ];

      if (input.items !== undefined) {
        statements.push(
          db.prepare(
            `DELETE FROM shipment_items WHERE shipment_id = ? AND shop_id = ?`,
          ).bind(shipmentId, shop),
        );
        const itemRows = supabaseItemsToD1Rows({
          items: input.items,
          shipmentId,
          shopId: shop,
          siNumber: nextSi,
          now,
          migrationVersion: D1_MIGRATION_VERSION,
          parseOptions: input.parseOptions,
        });
        for (const row of itemRows) {
          statements.push(
            db.prepare(
              `INSERT INTO shipment_items (
                 id, shipment_id, shop_id, si_number, name, product_code, quantity,
                 unit_price, variant_id, sort_order,
                 migration_source, migration_version, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              row.id,
              row.shipment_id,
              row.shop_id,
              row.si_number,
              row.name,
              row.product_code,
              row.quantity,
              row.unit_price,
              row.variant_id,
              row.sort_order,
              row.migration_source,
              row.migration_version,
              row.created_at,
              row.updated_at,
            ),
          );
        }
      } else if (nextSi !== si) {
        statements.push(
          db.prepare(
            `UPDATE shipment_items SET si_number = ?, updated_at = ?
             WHERE shipment_id = ? AND shop_id = ?`,
          ).bind(nextSi, now, shipmentId, shop),
        );
      }

      try {
        await db.batch(statements);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ShipmentDuplicateError(shop, nextSi);
        }
        throw error;
      }

      return this.getByShopAndSi(shop, nextSi);
    },

    async delete(shopId, siNumber) {
      const shop = normalizeShopDomain(shopId);
      const si = siNumber.trim();
      if (!shop || !si) return false;
      const result = await db
        .prepare(`DELETE FROM shipments WHERE shop_id = ? AND si_number = ?`)
        .bind(shop, si)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async countByShop(shopId) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) return 0;
      const row = await db
        .prepare(`SELECT COUNT(*) AS c FROM shipments WHERE shop_id = ?`)
        .bind(shop)
        .first<{ c: number }>();
      return Number(row?.c ?? 0);
    },

    async deleteAllByShop(shopId) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) return 0;
      const result = await db
        .prepare(`DELETE FROM shipments WHERE shop_id = ?`)
        .bind(shop)
        .run();
      return result.meta.changes ?? 0;
    },
  };
}

/** Normalize for stable round-trip comparison in tests. */
export function normalizeShipmentForCompare(
  row: SupabaseCompatibleShipment,
): SupabaseCompatibleShipment {
  return {
    ...row,
    si_number: row.si_number.trim(),
    items: row.items.map((item) => ({
      sync_item_id: item.sync_item_id,
      name: item.name,
      quantity: item.quantity == null ? item.quantity : Number(item.quantity),
      product_code: item.product_code ?? null,
      unit_price: item.unit_price ?? null,
      variant_id: item.variant_id,
    })),
  };
}
