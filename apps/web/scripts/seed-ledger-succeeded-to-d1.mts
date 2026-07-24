/**
 * Seed Supabase succeeded ledger rows → D1 (Stage L2).
 * Only status=succeeded. Idempotent insert; conflict stops.
 *
 * Usage (apps/web, env loaded e.g. via dotenv / shell):
 *   npx tsx scripts/seed-ledger-succeeded-to-d1.mts --dry-run
 *   npx tsx scripts/seed-ledger-succeeded-to-d1.mts --apply --remote
 *   npx tsx scripts/seed-ledger-succeeded-to-d1.mts --apply --local
 *
 * Does not mutate Supabase, Redis, or Shopify inventory.
 */
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DRY_RUN = process.argv.includes("--dry-run") || !process.argv.includes("--apply");
const REMOTE = process.argv.includes("--remote");
const LOCAL = process.argv.includes("--local") || !REMOTE;
const targetFlag = REMOTE ? "--remote" : "--local";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sqlString(value: string | null | undefined): string {
  if (value == null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNum(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("non-finite number");
  return String(n);
}

type LedgerSeedRow = {
  id: string;
  shop_id: string;
  si_number: string;
  item_key: string;
  idempotency_key: string;
  variant_id: string;
  inventory_item_id: string | null;
  location_id: string | null;
  delta_quantity: number;
  status: string;
  attempt_count: number;
  started_at: string | null;
  completed_at: string | null;
  shopify_adjustment_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function d1Execute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "track-to-inventory",
      targetFlag,
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", cwd: webRoot },
  );
  if (result.status !== 0) {
    throw new Error(`d1 execute failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout) as Array<{
    results?: Array<Record<string, unknown>>;
  }>;
  return parsed[0]?.results ?? [];
}

function compareKeys(a: LedgerSeedRow, b: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  const checks: Array<[keyof LedgerSeedRow, string]> = [
    ["id", "id"],
    ["shop_id", "shop_id"],
    ["si_number", "si_number"],
    ["item_key", "item_key"],
    ["idempotency_key", "idempotency_key"],
    ["status", "status"],
    ["variant_id", "variant_id"],
    ["delta_quantity", "delta_quantity"],
    ["shopify_adjustment_id", "shopify_adjustment_id"],
  ];
  for (const [src, dest] of checks) {
    const left = a[src] == null ? "" : String(a[src]);
    const right = b[dest] == null ? "" : String(b[dest]);
    if (src === "delta_quantity") {
      if (Number(left) !== Number(right)) diffs.push(dest);
    } else if (left !== right) {
      diffs.push(dest);
    }
  }
  return diffs;
}

async function main() {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const { data, error } = await supabase
    .from("inventory_sync_ledger")
    .select(
      "id, shop_id, si_number, item_key, idempotency_key, variant_id, inventory_item_id, location_id, delta_quantity, status, attempt_count, started_at, completed_at, shopify_adjustment_id, error_code, error_message, created_at, updated_at",
    )
    .eq("status", "succeeded")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  const rows = (data || []) as LedgerSeedRow[];

  console.log(
    JSON.stringify({
      type: "d1_ledger_seed_start",
      mode: DRY_RUN ? "dry-run" : "apply",
      target: REMOTE ? "remote" : "local",
      succeeded_count: rows.length,
    }),
  );

  let inserted = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const row of rows) {
    const existing = d1Execute(
      `SELECT id, shop_id, si_number, item_key, idempotency_key, status, variant_id, delta_quantity, shopify_adjustment_id
       FROM inventory_sync_ledger
       WHERE idempotency_key = ${sqlString(row.idempotency_key)}
       LIMIT 1`,
    )[0];

    if (existing) {
      const diffs = compareKeys(row, existing);
      if (diffs.length === 0) {
        skipped += 1;
        console.log(
          JSON.stringify({
            type: "d1_ledger_seed_skip",
            reason: "identical",
            idempotency_key_prefix: row.idempotency_key.slice(0, 12),
            shop_id: row.shop_id,
          }),
        );
        continue;
      }
      conflicts += 1;
      console.log(
        JSON.stringify({
          type: "d1_ledger_seed_conflict",
          idempotency_key_prefix: row.idempotency_key.slice(0, 12),
          shop_id: row.shop_id,
          diff_fields: diffs,
        }),
      );
      throw new Error(
        `conflict on idempotency_key prefix ${row.idempotency_key.slice(0, 12)} fields=${diffs.join(",")}`,
      );
    }

    const now = new Date().toISOString();
    const sql = `INSERT INTO inventory_sync_ledger (
      id, shop_id, si_number, item_key, idempotency_key, variant_id,
      inventory_item_id, location_id, delta_quantity, status, attempt_count,
      claim_token, claimed_at, started_at, completed_at, succeeded_at, ambiguous_at,
      shopify_adjustment_id, error_code, error_message, row_version,
      migration_source, migration_version, created_at, updated_at
    ) VALUES (
      ${sqlString(row.id)},
      ${sqlString(row.shop_id)},
      ${sqlString(row.si_number)},
      ${sqlString(row.item_key)},
      ${sqlString(row.idempotency_key)},
      ${sqlString(row.variant_id)},
      ${sqlString(row.inventory_item_id)},
      ${sqlString(row.location_id)},
      ${sqlNum(row.delta_quantity)},
      'succeeded',
      ${sqlNum(row.attempt_count ?? 1)},
      NULL,
      ${sqlString(row.started_at)},
      ${sqlString(row.started_at)},
      ${sqlString(row.completed_at)},
      ${sqlString(row.completed_at)},
      NULL,
      ${sqlString(row.shopify_adjustment_id)},
      NULL,
      NULL,
      1,
      'supabase',
      'l2-v1',
      ${sqlString(row.created_at || now)},
      ${sqlString(row.updated_at || now)}
    )`;

    if (DRY_RUN) {
      inserted += 1;
      console.log(
        JSON.stringify({
          type: "d1_ledger_seed_would_insert",
          idempotency_key_prefix: row.idempotency_key.slice(0, 12),
          shop_id: row.shop_id,
          status: row.status,
        }),
      );
      continue;
    }

    d1Execute(sql);
    inserted += 1;
    console.log(
      JSON.stringify({
        type: "d1_ledger_seed_inserted",
        idempotency_key_prefix: row.idempotency_key.slice(0, 12),
        shop_id: row.shop_id,
      }),
    );
  }

  const d1Count = d1Execute(
    `SELECT COUNT(*) AS c FROM inventory_sync_ledger WHERE status = 'succeeded'`,
  )[0];

  console.log(
    JSON.stringify({
      type: "d1_ledger_seed_done",
      mode: DRY_RUN ? "dry-run" : "apply",
      target: REMOTE ? "remote" : "local",
      supabase_succeeded: rows.length,
      inserted,
      skipped,
      conflicts,
      d1_succeeded_after: Number(d1Count?.c ?? -1),
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
