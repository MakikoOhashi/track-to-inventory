/**
 * Stage L9.2: Production Supabase shipments → D1 backfill gate.
 *
 * Remote writes use `wrangler d1 execute --remote` (not getPlatformProxy), so rows
 * persist to production D1.
 *
 * Usage (from apps/web):
 *   npx tsx --env-file=../../.env.local scripts/d1-l92-shipments-backfill-gate.mts --precheck --remote
 *   npx tsx --env-file=../../.env.local scripts/d1-l92-shipments-backfill-gate.mts --full --remote
 *
 * Does not change routes, flags, deploy, or Supabase.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getPlatformProxy } from "wrangler";
import * as bindings from "../app/lib/cloudflareBindings.server.ts";
import {
  createShipmentsRepository,
  normalizeShipmentForCompare,
  type SupabaseCompatibleShipment,
} from "../app/lib/d1/shipments.server.ts";
import {
  d1RowsToSupabaseItems,
  fingerprintD1ItemRows,
  type D1ShipmentItemRow,
} from "../app/lib/d1/shipmentItemsCompat.server.ts";
import {
  validateSupabaseItemsForBackfill,
  withBackfillUpsert,
  type SupabaseShipmentRow,
} from "../app/lib/d1/shipmentsBackfill.server.ts";
import { D1_MIGRATION_VERSION } from "../app/lib/d1/client.server.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = process.argv.includes("--remote") || !process.argv.includes("--local");
const targetFlag = REMOTE ? "--remote" : "--local";

const PRECHECK = process.argv.includes("--precheck") || process.argv.includes("--full");
const APPLY_MIGRATION =
  process.argv.includes("--apply-migration") || process.argv.includes("--full");
const APPLY_BACKFILL =
  process.argv.includes("--apply-backfill") || process.argv.includes("--full");
const VERIFY = process.argv.includes("--verify") || process.argv.includes("--full");
const IDEMPOTENCY =
  process.argv.includes("--idempotency") || process.argv.includes("--full");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }));
}

function wrangler(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    cwd: webRoot,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function d1Execute(sql: string): Array<Record<string, unknown>> {
  const result = wrangler([
    "d1",
    "execute",
    "track-to-inventory",
    targetFlag,
    "--command",
    sql,
    "--json",
  ]);
  if (result.status !== 0) {
    throw new Error(`d1 execute failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout) as Array<{ results?: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}

function d1ExecuteFile(sql: string): void {
  const dir = mkdtempSync(join(tmpdir(), "l92-d1-"));
  const file = join(dir, "batch.sql");
  writeFileSync(file, sql, "utf8");
  try {
    const result = wrangler([
      "d1",
      "execute",
      "track-to-inventory",
      targetFlag,
      "--file",
      file,
      "--json",
    ]);
    if (result.status !== 0) {
      throw new Error(`d1 execute file failed: ${result.stderr || result.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sqlString(value: string | null | undefined): string {
  if (value == null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlBool(value: boolean): string {
  return value ? "1" : "0";
}

function sqlNum(value: number | null | undefined): string {
  if (value == null) return "NULL";
  return String(value);
}

function emptyToNull(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

function nowIso(): string {
  return new Date().toISOString();
}

function supabaseRowToComparable(row: SupabaseShipmentRow): SupabaseCompatibleShipment {
  const validated = validateSupabaseItemsForBackfill({ row });
  if (!validated.ok) throw validated.error;

  return normalizeShipmentForCompare({
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
    items: d1RowsToSupabaseItems(validated.itemRows),
  });
}

type CompareMismatch = {
  kind: "missing_in_d1" | "extra_in_d1" | "field_mismatch";
  shop_id: string;
  si_number: string;
  field?: string;
  supabase?: unknown;
  d1?: unknown;
};

function compareShipment(
  supabase: SupabaseCompatibleShipment,
  d1: SupabaseCompatibleShipment | undefined,
): CompareMismatch[] {
  if (!d1) {
    return [{ kind: "missing_in_d1", shop_id: supabase.shop_id, si_number: supabase.si_number }];
  }

  const mismatches: CompareMismatch[] = [];
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
    if (supabase[field] !== d1[field]) {
      mismatches.push({
        kind: "field_mismatch",
        shop_id: supabase.shop_id,
        si_number: supabase.si_number,
        field,
        supabase: supabase[field],
        d1: d1[field],
      });
    }
  }

  if (supabase.items.length !== d1.items.length) {
    mismatches.push({
      kind: "field_mismatch",
      shop_id: supabase.shop_id,
      si_number: supabase.si_number,
      field: "items.length",
      supabase: supabase.items.length,
      d1: d1.items.length,
    });
  }

  for (let i = 0; i < supabase.items.length; i++) {
    const a = supabase.items[i];
    const b = d1.items[i];
    if (!b) continue;
    for (const key of [
      "sync_item_id",
      "name",
      "quantity",
      "product_code",
      "unit_price",
      "variant_id",
    ] as const) {
      const av = a[key] ?? null;
      const bv = b[key] ?? null;
      if (av !== bv && !(av == null && bv == null)) {
        mismatches.push({
          kind: "field_mismatch",
          shop_id: supabase.shop_id,
          si_number: supabase.si_number,
          field: `items[${i}].${key}`,
          supabase: av,
          d1: bv,
        });
      }
    }
  }

  return mismatches;
}

function mapD1ItemRow(raw: Record<string, unknown>): D1ShipmentItemRow {
  return {
    id: String(raw.id),
    shipment_id: String(raw.shipment_id),
    shop_id: String(raw.shop_id),
    si_number: String(raw.si_number),
    name: raw.name == null ? null : String(raw.name),
    product_code: raw.product_code == null ? null : String(raw.product_code),
    quantity: raw.quantity == null ? null : Number(raw.quantity),
    unit_price: raw.unit_price == null ? null : String(raw.unit_price),
    variant_id: raw.variant_id == null ? null : String(raw.variant_id),
    sort_order: Number(raw.sort_order),
    migration_source: raw.migration_source == null ? null : String(raw.migration_source),
    migration_version: raw.migration_version == null ? null : String(raw.migration_version),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  };
}

function loadD1Shipment(shopId: string, siNumber: string): SupabaseCompatibleShipment | undefined {
  const shop = shopId.trim();
  const si = siNumber.trim();
  const raw = d1Execute(
    `SELECT id, shop_id, si_number, status, supplier_name, transport_type, memo,
            etd, eta, clearance_date, arrival_date, delayed, is_archived,
            invoice_url, pl_url, si_url, other_url
     FROM shipments
     WHERE shop_id = ${sqlString(shop)} AND si_number = ${sqlString(si)}
     LIMIT 1`,
  )[0];
  if (!raw) return undefined;

  const itemRows = d1Execute(
    `SELECT id, shipment_id, shop_id, si_number, name, product_code, quantity,
            unit_price, variant_id, sort_order, migration_source, migration_version,
            created_at, updated_at
     FROM shipment_items
     WHERE shipment_id = ${sqlString(String(raw.id))} AND shop_id = ${sqlString(shop)}
     ORDER BY sort_order ASC, id ASC`,
  ).map(mapD1ItemRow);

  return normalizeShipmentForCompare({
    id: String(raw.id),
    shop_id: String(raw.shop_id),
    si_number: String(raw.si_number),
    status: String(raw.status ?? ""),
    supplier_name: emptyToNull(raw.supplier_name),
    transport_type: emptyToNull(raw.transport_type),
    memo: emptyToNull(raw.memo),
    etd: emptyToNull(raw.etd),
    eta: emptyToNull(raw.eta),
    clearance_date: emptyToNull(raw.clearance_date),
    arrival_date: emptyToNull(raw.arrival_date),
    delayed: Number(raw.delayed ?? 0) === 1,
    is_archived: Number(raw.is_archived ?? 0) === 1,
    invoice_url: emptyToNull(raw.invoice_url),
    pl_url: emptyToNull(raw.pl_url),
    si_url: emptyToNull(raw.si_url),
    other_url: emptyToNull(raw.other_url),
    items: d1RowsToSupabaseItems(itemRows),
  });
}

async function withLocalDb<T>(fn: (db: D1Database) => Promise<T>): Promise<T> {
  const proxy = await getPlatformProxy({
    configPath: join(webRoot, "wrangler.jsonc"),
    persist: true,
  });
  try {
    const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
    if (!db) throw new Error("TTI_DB binding missing");
    return await bindings.runWithCloudflareEnv(
      { env: proxy.env as Env, ctx: {} as ExecutionContext },
      () => fn(db),
    );
  } finally {
    await proxy.dispose();
  }
}

async function fetchSupabaseShipments(): Promise<SupabaseShipmentRow[]> {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
  const { data, error } = await supabase
    .from("shipments")
    .select("*")
    .order("shop_id")
    .order("si_number");
  if (error) throw new Error(error.message);
  return (data ?? []) as SupabaseShipmentRow[];
}

function snapshotD1Counts() {
  const shipments = d1Execute("SELECT id, shop_id, si_number FROM shipments ORDER BY shop_id, si_number");
  const items = d1Execute(
    "SELECT id, shipment_id, shop_id, si_number, sort_order FROM shipment_items ORDER BY shipment_id, sort_order",
  );
  const ledger = d1Execute("SELECT COUNT(*) AS c FROM inventory_sync_ledger")[0];
  const sessions = d1Execute("SELECT COUNT(*) AS c FROM shopify_sessions")[0];
  return {
    shipmentCount: shipments.length,
    itemCount: items.length,
    shipmentIds: shipments.map((r) => String(r.id)),
    itemIds: items.map((r) => String(r.id)),
    inventory_sync_ledger: Number(ledger?.c ?? 0),
    shopify_sessions: Number(sessions?.c ?? 0),
  };
}

function itemFingerprintFromDb(shipmentIds: string[]): string[] {
  if (shipmentIds.length === 0) return [];
  const inList = shipmentIds.map((id) => sqlString(id)).join(",");
  const rows = d1Execute(
    `SELECT id, shipment_id, shop_id, si_number, name, product_code, quantity,
            unit_price, variant_id, sort_order
     FROM shipment_items WHERE shipment_id IN (${inList})
     ORDER BY shipment_id, sort_order, id`,
  );
  return fingerprintD1ItemRows(rows.map(mapD1ItemRow));
}

function buildBackfillSql(row: SupabaseShipmentRow): { sql: string; action: "insert" | "update"; itemCount: number } {
  const validated = validateSupabaseItemsForBackfill({ row });
  if (!validated.ok) throw validated.error;

  const now = nowIso();
  const existing = d1Execute(
    `SELECT id FROM shipments
     WHERE shop_id = ${sqlString(validated.shopId)} AND si_number = ${sqlString(validated.siNumber)}
     LIMIT 1`,
  )[0];
  const action = existing ? "update" : "insert";

  const lines: string[] = [
    "PRAGMA foreign_keys = ON;",
    `INSERT OR IGNORE INTO shops (shop_id, migration_source, migration_version, created_at, updated_at)
     VALUES (${sqlString(validated.shopId)}, 'runtime', ${sqlString(D1_MIGRATION_VERSION)}, ${sqlString(now)}, ${sqlString(now)});`,
  ];

  if (action === "insert") {
    lines.push(
      `INSERT INTO shipments (
         id, shop_id, si_number, status, supplier_name, transport_type, memo,
         etd, eta, clearance_date, arrival_date, delayed, is_archived,
         invoice_url, pl_url, si_url, other_url, version,
         migration_source, migration_version, created_at, updated_at
       ) VALUES (
         ${sqlString(validated.shipmentId)},
         ${sqlString(validated.shopId)},
         ${sqlString(validated.siNumber)},
         ${sqlString(row.status ?? "SI発行済")},
         ${sqlString(emptyToNull(row.supplier_name))},
         ${sqlString(emptyToNull(row.transport_type))},
         ${sqlString(emptyToNull(row.memo))},
         ${sqlString(emptyToNull(row.etd))},
         ${sqlString(emptyToNull(row.eta))},
         ${sqlString(emptyToNull(row.clearance_date))},
         ${sqlString(emptyToNull(row.arrival_date))},
         ${sqlBool(Boolean(row.delayed))},
         ${sqlBool(Boolean(row.is_archived))},
         ${sqlString(emptyToNull(row.invoice_url))},
         ${sqlString(emptyToNull(row.pl_url))},
         ${sqlString(emptyToNull(row.si_url))},
         ${sqlString(emptyToNull(row.other_url))},
         1,
         'runtime',
         ${sqlString(D1_MIGRATION_VERSION)},
         ${sqlString(now)},
         ${sqlString(now)}
       );`,
    );
  } else {
    lines.push(
      `UPDATE shipments SET
         status = ${sqlString(row.status ?? "SI発行済")},
         supplier_name = ${sqlString(emptyToNull(row.supplier_name))},
         transport_type = ${sqlString(emptyToNull(row.transport_type))},
         memo = ${sqlString(emptyToNull(row.memo))},
         etd = ${sqlString(emptyToNull(row.etd))},
         eta = ${sqlString(emptyToNull(row.eta))},
         clearance_date = ${sqlString(emptyToNull(row.clearance_date))},
         arrival_date = ${sqlString(emptyToNull(row.arrival_date))},
         delayed = ${sqlBool(Boolean(row.delayed))},
         is_archived = ${sqlBool(Boolean(row.is_archived))},
         invoice_url = ${sqlString(emptyToNull(row.invoice_url))},
         pl_url = ${sqlString(emptyToNull(row.pl_url))},
         si_url = ${sqlString(emptyToNull(row.si_url))},
         other_url = ${sqlString(emptyToNull(row.other_url))},
         version = version + 1,
         updated_at = ${sqlString(now)},
         migration_source = 'runtime',
         migration_version = ${sqlString(D1_MIGRATION_VERSION)}
       WHERE id = ${sqlString(validated.shipmentId)} AND shop_id = ${sqlString(validated.shopId)};`,
    );
  }

  lines.push(
    `DELETE FROM shipment_items
     WHERE shipment_id = ${sqlString(validated.shipmentId)} AND shop_id = ${sqlString(validated.shopId)};`,
  );

  for (const item of validated.itemRows) {
    lines.push(
      `INSERT INTO shipment_items (
         id, shipment_id, shop_id, si_number, name, product_code, quantity,
         unit_price, variant_id, sort_order,
         migration_source, migration_version, created_at, updated_at
       ) VALUES (
         ${sqlString(item.id)},
         ${sqlString(item.shipment_id)},
         ${sqlString(item.shop_id)},
         ${sqlString(item.si_number)},
         ${sqlString(item.name)},
         ${sqlString(item.product_code)},
         ${sqlNum(item.quantity)},
         ${sqlString(item.unit_price)},
         ${sqlString(item.variant_id)},
         ${sqlNum(item.sort_order)},
         ${sqlString(item.migration_source)},
         ${sqlString(item.migration_version)},
         ${sqlString(item.created_at)},
         ${sqlString(item.updated_at)}
       );`,
    );
  }

  return { sql: lines.join("\n"), action, itemCount: validated.itemRows.length };
}

async function runPrecheck(rows: SupabaseShipmentRow[]) {
  const migList = wrangler(["d1", "migrations", "list", "track-to-inventory", targetFlag]);
  const before = snapshotD1Counts();
  const migration0004 = readFileSync(
    join(webRoot, "migrations/0004_shipments_file_urls.sql"),
    "utf8",
  );

  let totalItems = 0;
  const dryRunPlans: Array<Record<string, unknown>> = [];
  let validationErrors = 0;

  for (const row of rows) {
    const items = Array.isArray(row.items) ? row.items.length : 0;
    totalItems += items;
    const validated = validateSupabaseItemsForBackfill({ row });
    if (!validated.ok) {
      validationErrors += 1;
      log({
        type: "l92_precheck_validation_error",
        shop_id: row.shop_id,
        si_number: row.si_number,
        error: validated.error.message,
      });
      continue;
    }
    dryRunPlans.push({
      shipment_id: validated.shipmentId,
      shop_id: validated.shopId,
      si_number: validated.siNumber,
      item_count: validated.itemRows.length,
      item_ids: validated.itemRows.map((r) => r.id),
      planned_action: before.shipmentIds.includes(validated.shipmentId) ? "update" : "insert",
    });
  }

  const pass =
    rows.length === 3 &&
    totalItems === 8 &&
    validationErrors === 0 &&
    migration0004.includes("ADD COLUMN") &&
    !migration0004.toLowerCase().includes("drop ");

  log({
    type: "l92_precheck",
    remote: REMOTE,
    migration_list_exit: migList.status,
    migration_0004_additive: true,
    d1_before: before,
    supabase_shipments: rows.length,
    supabase_items: totalItems,
    validation_errors: validationErrors,
    dry_run_plans: dryRunPlans,
    pass,
  });

  if (!pass) {
    throw new Error("L9.2 precheck failed — aborting");
  }
  return { before, dryRunPlans, totalItems };
}

function applyMigration0004() {
  const result = wrangler([
    "d1",
    "migrations",
    "apply",
    "track-to-inventory",
    targetFlag,
  ]);
  log({
    type: "l92_migration_apply",
    exit: result.status,
    stdout: result.stdout.slice(0, 2000),
    stderr: result.stderr.slice(0, 500),
  });
  if (result.status !== 0) {
    throw new Error("Migration apply failed — aborting backfill");
  }

  const schema = d1Execute(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='shipments'",
  )[0]?.sql;
  const ok =
    typeof schema === "string" &&
    schema.includes("invoice_url") &&
    schema.includes("other_url");
  log({ type: "l92_migration_schema_check", ok, has_invoice_url: ok });
  if (!ok) throw new Error("Schema check after 0004 failed");
}

async function runBackfill(rows: SupabaseShipmentRow[]) {
  const results: Array<Record<string, unknown>> = [];

  if (REMOTE) {
    for (const row of rows) {
      const plan = buildBackfillSql(row);
      d1ExecuteFile(plan.sql);
      results.push({
        shop_id: row.shop_id,
        si_number: row.si_number,
        action: plan.action === "insert" ? "inserted" : "updated",
        item_count: plan.itemCount,
        transport: "wrangler_d1_execute_remote",
      });
    }
  } else {
    await withLocalDb(async (db) => {
      const repo = withBackfillUpsert(createShipmentsRepository(db));
      for (const row of rows) {
        const out = await repo.upsertFromSupabaseBackfill(row);
        results.push({
          shop_id: row.shop_id,
          si_number: row.si_number,
          action: out.action,
          item_count: out.itemCount,
          transport: "local_repository",
        });
      }
    });
  }

  log({ type: "l92_backfill_apply", results });
  return results;
}

async function runVerify(rows: SupabaseShipmentRow[]) {
  const mismatches: CompareMismatch[] = [];
  const expectedIds = new Set(rows.map((r) => r.id.trim()));

  for (const row of rows) {
    const expected = supabaseRowToComparable(row);
    const d1 = loadD1Shipment(row.shop_id, row.si_number);
    mismatches.push(...compareShipment(expected, d1));
  }

  const allD1 = d1Execute("SELECT id, shop_id, si_number FROM shipments ORDER BY shop_id, si_number");
  for (const raw of allD1) {
    const id = String(raw.id);
    if (!expectedIds.has(id)) {
      mismatches.push({
        kind: "extra_in_d1",
        shop_id: String(raw.shop_id),
        si_number: String(raw.si_number),
      });
    }
  }

  const byKind = {
    missing_in_d1: mismatches.filter((m) => m.kind === "missing_in_d1").length,
    extra_in_d1: mismatches.filter((m) => m.kind === "extra_in_d1").length,
    field_mismatch: mismatches.filter((m) => m.kind === "field_mismatch").length,
  };

  log({
    type: "l92_verify",
    pass: mismatches.length === 0,
    mismatch_count: mismatches.length,
    by_kind: byKind,
    mismatches,
  });

  if (mismatches.length > 0) {
    throw new Error("L9.2 verify failed — mismatches present");
  }
}

async function runIdempotency(
  rows: SupabaseShipmentRow[],
  firstSnapshot: ReturnType<typeof snapshotD1Counts>,
  firstFp: string[],
) {
  await runBackfill(rows);
  const secondSnapshot = snapshotD1Counts();
  const shipmentIds = rows.map((r) => r.id);
  const secondFp = itemFingerprintFromDb(shipmentIds);

  const stale = d1Execute(
    "SELECT id, COUNT(*) AS c FROM shipment_items GROUP BY id HAVING c > 1",
  );

  const extraItems = d1Execute(
    `SELECT COUNT(*) AS c FROM shipment_items WHERE shipment_id NOT IN (${shipmentIds.map((id) => sqlString(id)).join(",")})`,
  )[0];

  const pass =
    firstSnapshot.shipmentCount === secondSnapshot.shipmentCount &&
    firstSnapshot.itemCount === secondSnapshot.itemCount &&
    JSON.stringify([...firstSnapshot.shipmentIds].sort()) ===
      JSON.stringify([...secondSnapshot.shipmentIds].sort()) &&
    JSON.stringify([...firstSnapshot.itemIds].sort()) ===
      JSON.stringify([...secondSnapshot.itemIds].sort()) &&
    JSON.stringify(firstFp) === JSON.stringify(secondFp) &&
    stale.length === 0 &&
    Number(extraItems?.c ?? 0) === 0;

  log({
    type: "l92_idempotency",
    pass,
    first: {
      shipments: firstSnapshot.shipmentCount,
      items: firstSnapshot.itemCount,
    },
    second: {
      shipments: secondSnapshot.shipmentCount,
      items: secondSnapshot.itemCount,
    },
    fingerprint_match: JSON.stringify(firstFp) === JSON.stringify(secondFp),
    duplicate_item_rows: stale.length,
    extra_items_outside_backfill: Number(extraItems?.c ?? 0),
    inventory_sync_ledger_unchanged:
      firstSnapshot.inventory_sync_ledger === secondSnapshot.inventory_sync_ledger,
    shopify_sessions_unchanged:
      firstSnapshot.shopify_sessions === secondSnapshot.shopify_sessions,
  });

  if (!pass) throw new Error("L9.2 idempotency check failed");
}

async function main() {
  log({ type: "l92_start", remote: REMOTE, argv: process.argv.slice(2) });

  const rows = await fetchSupabaseShipments();
  const ledgerBefore = snapshotD1Counts().inventory_sync_ledger;
  const sessionsBefore = snapshotD1Counts().shopify_sessions;

  let firstSnapshot = snapshotD1Counts();
  let firstFp: string[] = [];

  if (PRECHECK) {
    await runPrecheck(rows);
  }

  if (APPLY_MIGRATION) {
    applyMigration0004();
  }

  if (APPLY_BACKFILL) {
    firstSnapshot = snapshotD1Counts();
    await runBackfill(rows);
    firstSnapshot = snapshotD1Counts();
    firstFp = itemFingerprintFromDb(rows.map((r) => r.id));

    if (firstSnapshot.shipmentCount !== rows.length || firstSnapshot.itemCount !== 8) {
      throw new Error(
        `Backfill persistence check failed: expected ${rows.length} shipments and 8 items, got ${firstSnapshot.shipmentCount} shipments and ${firstSnapshot.itemCount} items`,
      );
    }

    log({
      type: "l92_backfill_counts",
      wrote_shipments: rows.length,
      wrote_items: 8,
      d1_shipments_after: firstSnapshot.shipmentCount,
      d1_items_after: firstSnapshot.itemCount,
      inventory_sync_ledger_before: ledgerBefore,
      inventory_sync_ledger_after: firstSnapshot.inventory_sync_ledger,
      shopify_sessions_before: sessionsBefore,
      shopify_sessions_after: firstSnapshot.shopify_sessions,
    });
  }

  if (VERIFY) {
    await runVerify(rows);
  }

  if (IDEMPOTENCY) {
    if (firstFp.length === 0) {
      firstSnapshot = snapshotD1Counts();
      firstFp = itemFingerprintFromDb(rows.map((r) => r.id));
    }
    await runIdempotency(rows, firstSnapshot, firstFp);
  }

  log({
    type: "l92_complete",
    l93_read_shadow_gate:
      VERIFY && IDEMPOTENCY ? "READY_FOR_L93_READ_SHADOW" : "RUN_VERIFY_AND_IDEMPOTENCY",
  });
}

main().catch((error) => {
  log({ type: "l92_error", message: error instanceof Error ? error.message : String(error) });
  console.error(error);
  process.exit(1);
});
