/**
 * D1 shipments shadow (Stage L9.3).
 * Supabase remains primary for user responses; D1 is compared on read and mirrored on write.
 * Never throws; never changes primary results.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  getCloudflareCtx,
  getOptionalTtiDb,
} from "~/lib/cloudflareBindings.server";
import {
  classifyD1Error,
  createShipmentsRepository,
  d1RowsToSupabaseItems,
  mirrorDeleteAllShipmentsOnD1,
  mirrorDeleteShipmentOnD1,
  mirrorSupabaseRowToD1,
  normalizeShipmentForCompare,
  supabaseItemsToD1Rows,
  type SupabaseCompatibleShipment,
  type SupabaseShipmentRow,
} from "~/lib/d1/index.server";
import { D1_MIGRATION_VERSION, nowIso } from "~/lib/d1/client.server";
import {
  getD1ShipmentsMode,
  isD1ShipmentsShadowActive,
} from "~/lib/d1ShipmentsMode.server";

export type ShipmentsShadowDiffCategory =
  | "match"
  | "missing_in_d1"
  | "extra_in_d1"
  | "field_mismatch"
  | "count_mismatch"
  | "d1_error"
  | "skipped_off";

export type ShipmentsShadowCause =
  | "pre_shadow_change"
  | "shadow_write_failure"
  | "comparison_normalization"
  | "none";

export type ShipmentsShadowReadOp = "list" | "get" | "count";

export type ShipmentsShadowWriteOp = "create" | "update" | "delete" | "delete_all";

type FieldDiff = {
  field: string;
  category: ShipmentsShadowDiffCategory;
};

const REDACTED_VALUE_FIELDS = new Set([
  "memo",
  "invoice_url",
  "pl_url",
  "si_url",
  "other_url",
]);

const ITEM_FIELD_KEYS = [
  "sync_item_id",
  "name",
  "quantity",
  "product_code",
  "unit_price",
  "variant_id",
] as const;

/**
 * Start a best-effort shadow task without delaying the user response.
 * In Cloudflare the task is attached to the request lifecycle with waitUntil.
 * Local/non-Worker execution still observes rejection to avoid an unhandled promise.
 */
export function scheduleShipmentsShadowTask(task: () => Promise<void>): void {
  let promise: Promise<void>;
  try {
    promise = task();
  } catch {
    return;
  }

  const settled = promise.catch(() => {
    // Shadow helpers already log classified failures and must never escape.
  });
  const ctx = getCloudflareCtx();
  if (ctx) {
    try {
      ctx.waitUntil(settled);
    } catch {
      void settled;
    }
    return;
  }
  void settled;
}

function safeShopId(shopId: string): string {
  return createHash("sha256").update(shopId).digest("hex").slice(0, 12);
}

function safeSiReference(siNumber: string | undefined): string | undefined {
  if (!siNumber) return undefined;
  return createHash("sha256").update(siNumber).digest("hex").slice(0, 12);
}

function isSensitiveField(field: string): boolean {
  if (REDACTED_VALUE_FIELDS.has(field)) return true;
  return field.startsWith("items[");
}

function sortBySiNumber<T extends { si_number: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.si_number.localeCompare(b.si_number));
}

/** Build comparable shipment from raw Supabase row (same normalization as L9.2 gate). */
export function supabaseRawToComparable(row: SupabaseShipmentRow): SupabaseCompatibleShipment {
  const shopId = row.shop_id.trim();
  const siNumber = row.si_number.trim();
  const shipmentId = row.id.trim();
  const itemRows = supabaseItemsToD1Rows({
    items: row.items,
    shipmentId,
    shopId,
    siNumber,
    now: nowIso(),
    migrationVersion: D1_MIGRATION_VERSION,
    parseOptions: { strictUnknownKeys: false },
  });
  return normalizeShipmentForCompare({
    id: shipmentId,
    shop_id: shopId,
    si_number: siNumber,
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
    items: d1RowsToSupabaseItems(itemRows),
  });
}

function emptyToNull(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

export function compareNormalizedShipments(
  primary: SupabaseCompatibleShipment,
  shadow: SupabaseCompatibleShipment | undefined,
): FieldDiff[] {
  if (!shadow) {
    return [{ field: "row", category: "missing_in_d1" }];
  }

  const diffs: FieldDiff[] = [];
  const fields: Array<keyof Omit<SupabaseCompatibleShipment, "items">> = [
    "id",
    "shop_id",
    "si_number",
    "status",
    "supplier_name",
    "transport_type",
    "memo",
    "etd",
    "eta",
    "clearance_date",
    "arrival_date",
    "delayed",
    "is_archived",
    "invoice_url",
    "pl_url",
    "si_url",
    "other_url",
  ];

  for (const field of fields) {
    if (primary[field] !== shadow[field]) {
      diffs.push({ field, category: "field_mismatch" });
    }
  }

  if (primary.items.length !== shadow.items.length) {
    diffs.push({ field: "items.length", category: "field_mismatch" });
  }

  for (let i = 0; i < primary.items.length; i++) {
    const a = primary.items[i];
    const b = shadow.items[i];
    if (!b) continue;
    for (const key of ITEM_FIELD_KEYS) {
      const av = a[key] ?? null;
      const bv = b[key] ?? null;
      if (av !== bv && !(av == null && bv == null)) {
        diffs.push({ field: `items[${i}].${key}`, category: "field_mismatch" });
      }
    }
  }

  return diffs;
}

export function compareShipmentLists(
  primaryRows: SupabaseShipmentRow[],
  shadowRows: SupabaseCompatibleShipment[],
): FieldDiff[] {
  const primary = sortBySiNumber(primaryRows.map(supabaseRawToComparable));
  const shadow = sortBySiNumber(shadowRows.map(normalizeShipmentForCompare));

  const diffs: FieldDiff[] = [];
  if (primary.length !== shadow.length) {
    diffs.push({ field: "list.length", category: "count_mismatch" });
  }

  const shadowBySi = new Map(shadow.map((row) => [row.si_number, row]));
  const primarySi = new Set(primary.map((row) => row.si_number));

  for (const row of primary) {
    const d1Row = shadowBySi.get(row.si_number);
    diffs.push(...compareNormalizedShipments(row, d1Row));
  }

  for (const row of shadow) {
    if (!primarySi.has(row.si_number)) {
      diffs.push({ field: "extra_row", category: "extra_in_d1" });
    }
  }

  return diffs;
}

function logShadowRead(payload: {
  correlation_id: string;
  shop_id: string;
  operation: ShipmentsShadowReadOp;
  si_number?: string;
  categories: ShipmentsShadowDiffCategory[];
  cause: ShipmentsShadowCause;
  field_diffs: string[];
  primary_count?: number;
  shadow_count?: number;
  latency_ms: number;
  error_class?: string;
}): void {
  try {
    const line = JSON.stringify({
      type: "shipments_d1_shadow_diff",
      ...payload,
      mode: getD1ShipmentsMode(),
    });
    if (/shpat_|sk_live|eyJhbGci/i.test(line)) return;
    console.log(line);
  } catch {
    // never affect request path
  }
}

function logShadowWrite(payload: {
  correlation_id: string;
  shop_id: string;
  operation: ShipmentsShadowWriteOp;
  si_number?: string;
  outcome: "ok" | "error";
  shadow_action?: string;
  item_count?: number;
  latency_ms: number;
  error_class?: string;
}): void {
  try {
    const line = JSON.stringify({
      type:
        payload.outcome === "error"
          ? "shipments_d1_shadow_write_error"
          : "shipments_d1_shadow_write",
      ...payload,
      mode: getD1ShipmentsMode(),
    });
    if (/shpat_|sk_live|eyJhbGci/i.test(line)) return;
    console.log(line);
  } catch {
    // never affect request path
  }
}

function summarizeCategories(fieldDiffs: FieldDiff[]): ShipmentsShadowDiffCategory[] {
  if (fieldDiffs.length === 0) return ["match"];
  const set = new Set(fieldDiffs.map((d) => d.category));
  return [...set];
}

function safeFieldNames(fieldDiffs: FieldDiff[]): string[] {
  return fieldDiffs.map((d) => d.field);
}

const recentWriteFailures = new Map<string, number>();
const WRITE_FAILURE_TTL_MS = 10 * 60 * 1000;

function failureKey(shopId: string, siNumber?: string): string {
  return `${shopId}\n${siNumber || "*"}`;
}

function rememberWriteFailure(shopId: string, siNumber?: string): void {
  const at = Date.now();
  recentWriteFailures.set(failureKey(shopId, siNumber), at);
  recentWriteFailures.set(failureKey(shopId), at);
}

function clearWriteFailure(shopId: string, siNumber?: string): void {
  recentWriteFailures.delete(failureKey(shopId, siNumber));
  if (siNumber) recentWriteFailures.delete(failureKey(shopId));
}

function classifyDiffCause(
  shopId: string,
  siNumber: string | undefined,
  fieldDiffs: FieldDiff[],
): ShipmentsShadowCause {
  if (fieldDiffs.length === 0) return "none";
  const now = Date.now();
  const failedAt =
    recentWriteFailures.get(failureKey(shopId, siNumber)) ??
    recentWriteFailures.get(failureKey(shopId));
  if (failedAt && now - failedAt <= WRITE_FAILURE_TTL_MS) {
    return "shadow_write_failure";
  }
  if (
    fieldDiffs.every(
      (diff) =>
        diff.category === "field_mismatch" &&
        (diff.field.startsWith("items[") || diff.field === "items.length"),
    )
  ) {
    return "comparison_normalization";
  }
  return "pre_shadow_change";
}

async function loadD1List(shopId: string): Promise<SupabaseCompatibleShipment[]> {
  const db = getOptionalTtiDb();
  if (!db) throw new Error("binding_missing");
  return createShipmentsRepository(db).listByShop(shopId);
}

async function loadD1Single(
  shopId: string,
  siNumber: string,
): Promise<SupabaseCompatibleShipment | undefined> {
  const db = getOptionalTtiDb();
  if (!db) throw new Error("binding_missing");
  return createShipmentsRepository(db).getByShopAndSi(shopId, siNumber);
}

async function loadD1Count(shopId: string): Promise<number> {
  const db = getOptionalTtiDb();
  if (!db) throw new Error("binding_missing");
  return createShipmentsRepository(db).countByShop(shopId);
}

/** After Supabase list read — compare with D1 (never throws). */
export async function shadowCompareListAfterRead(params: {
  correlationId?: string;
  shopId: string;
  primaryRows: SupabaseShipmentRow[];
}): Promise<void> {
  if (!isD1ShipmentsShadowActive()) return;

  const correlationId = params.correlationId || randomUUID();
  const started = Date.now();

  try {
    const shadowRows = await loadD1List(params.shopId);
    const fieldDiffs = compareShipmentLists(params.primaryRows, shadowRows);
    logShadowRead({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: "list",
      categories: summarizeCategories(fieldDiffs),
      cause: classifyDiffCause(params.shopId, undefined, fieldDiffs),
      field_diffs: safeFieldNames(fieldDiffs),
      primary_count: params.primaryRows.length,
      shadow_count: shadowRows.length,
      latency_ms: Date.now() - started,
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    logShadowRead({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: "list",
      categories: ["d1_error"],
      cause: "none",
      field_diffs: [],
      primary_count: params.primaryRows.length,
      latency_ms: Date.now() - started,
      error_class: classified.classification,
    });
  }
}

/** After Supabase single-row read — compare with D1 (never throws). */
export async function shadowCompareGetAfterRead(params: {
  correlationId?: string;
  shopId: string;
  siNumber: string;
  primaryRow: SupabaseShipmentRow | null;
}): Promise<void> {
  if (!isD1ShipmentsShadowActive()) return;

  const correlationId = params.correlationId || randomUUID();
  const started = Date.now();

  try {
    const shadowRow = await loadD1Single(params.shopId, params.siNumber);
    const fieldDiffs = params.primaryRow
      ? compareNormalizedShipments(
          supabaseRawToComparable(params.primaryRow),
          shadowRow ? normalizeShipmentForCompare(shadowRow) : undefined,
        )
      : shadowRow
        ? [{ field: "row", category: "extra_in_d1" } satisfies FieldDiff]
        : [];
    logShadowRead({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: "get",
      si_number: safeSiReference(params.siNumber),
      categories: summarizeCategories(fieldDiffs),
      cause: classifyDiffCause(params.shopId, params.siNumber, fieldDiffs),
      field_diffs: safeFieldNames(fieldDiffs),
      latency_ms: Date.now() - started,
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    logShadowRead({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: "get",
      si_number: safeSiReference(params.siNumber),
      categories: ["d1_error"],
      cause: "none",
      field_diffs: [],
      latency_ms: Date.now() - started,
      error_class: classified.classification,
    });
  }
}

/** After Supabase count — compare with D1 count (never throws). */
export async function shadowCompareCountAfterRead(params: {
  correlationId?: string;
  shopId: string;
  primaryCount: number;
}): Promise<void> {
  if (!isD1ShipmentsShadowActive()) return;

  const correlationId = params.correlationId || randomUUID();
  const started = Date.now();

  try {
    const shadowCount = await loadD1Count(params.shopId);
    const fieldDiffs: FieldDiff[] =
      params.primaryCount !== shadowCount
        ? [{ field: "count", category: "count_mismatch" }]
        : [];
    logShadowRead({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: "count",
      categories: summarizeCategories(fieldDiffs),
      cause: classifyDiffCause(params.shopId, undefined, fieldDiffs),
      field_diffs: safeFieldNames(fieldDiffs),
      primary_count: params.primaryCount,
      shadow_count: shadowCount,
      latency_ms: Date.now() - started,
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    logShadowRead({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: "count",
      categories: ["d1_error"],
      cause: "none",
      field_diffs: [],
      primary_count: params.primaryCount,
      latency_ms: Date.now() - started,
      error_class: classified.classification,
    });
  }
}

/** Mirror Supabase row to D1 after primary mutation success (never throws). */
export async function shadowWriteShipmentMirror(params: {
  correlationId?: string;
  operation: ShipmentsShadowWriteOp;
  shopId: string;
  siNumber?: string;
  row?: SupabaseShipmentRow;
}): Promise<void> {
  if (!isD1ShipmentsShadowActive()) return;

  const correlationId = params.correlationId || randomUUID();
  const started = Date.now();
  const db = getOptionalTtiDb();

  if (!db) {
    logShadowWrite({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: params.operation,
      si_number: params.siNumber,
      outcome: "error",
      latency_ms: Date.now() - started,
      error_class: "binding_missing",
    });
    rememberWriteFailure(params.shopId, params.siNumber);
    return;
  }

  try {
    if (params.operation === "delete_all") {
      const deleted = await mirrorDeleteAllShipmentsOnD1(db, params.shopId);
      logShadowWrite({
        correlation_id: correlationId,
        shop_id: safeShopId(params.shopId),
        operation: "delete_all",
        outcome: "ok",
        shadow_action: "deleted",
        item_count: deleted,
        latency_ms: Date.now() - started,
      });
      clearWriteFailure(params.shopId);
      return;
    }

    if (params.operation === "delete") {
      if (!params.siNumber) throw new Error("si_number required for delete mirror");
      const ok = await mirrorDeleteShipmentOnD1(
        db,
        params.shopId,
        params.siNumber,
      );
      logShadowWrite({
        correlation_id: correlationId,
        shop_id: safeShopId(params.shopId),
        operation: "delete",
        si_number: safeSiReference(params.siNumber),
        outcome: "ok",
        shadow_action: ok ? "deleted" : "not_found",
        latency_ms: Date.now() - started,
      });
      clearWriteFailure(params.shopId, params.siNumber);
      return;
    }

    if (!params.row) throw new Error("row required for upsert mirror");
    const result = await mirrorSupabaseRowToD1(db, params.row);
    logShadowWrite({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: params.operation,
      si_number: safeSiReference(params.row.si_number),
      outcome: "ok",
      shadow_action: result.action,
      item_count: result.itemCount,
      latency_ms: Date.now() - started,
    });
    clearWriteFailure(params.shopId, params.row.si_number);
  } catch (error) {
    const classified = classifyD1Error(error);
    logShadowWrite({
      correlation_id: correlationId,
      shop_id: safeShopId(params.shopId),
      operation: params.operation,
      si_number: safeSiReference(params.siNumber || params.row?.si_number),
      outcome: "error",
      latency_ms: Date.now() - started,
      error_class: classified.classification,
    });
    rememberWriteFailure(params.shopId, params.siNumber || params.row?.si_number);
  }
}

/** Test helper */
export function shipmentsShadowWouldRun(): boolean {
  return isD1ShipmentsShadowActive();
}

export { isSensitiveField };
