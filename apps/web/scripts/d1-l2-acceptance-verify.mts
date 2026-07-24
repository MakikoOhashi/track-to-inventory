/**
 * Read-only L2 acceptance: Supabase + D1 succeeded pairs → already_synced_match.
 * Calls Supabase claim RPC only (already_synced → mutation 0). Does not call Shopify.
 *
 *   npx tsx --env-file=.env.local scripts/d1-l2-acceptance-verify.mts --remote
 */
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyD1ShadowClaim } from "../app/lib/d1LedgerShadow.server.ts";
import type { ClaimResult } from "../app/lib/syncLedger.server.ts";

const REMOTE = process.argv.includes("--remote") || !process.argv.includes("--local");
const targetFlag = REMOTE ? "--remote" : "--local";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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

async function main() {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const { data: beforeRows, error } = await supabase
    .from("inventory_sync_ledger")
    .select(
      "id, shop_id, si_number, item_key, idempotency_key, variant_id, delta_quantity, status, attempt_count, started_at, completed_at, shopify_adjustment_id, inventory_item_id, location_id, error_code, error_message",
    )
    .eq("status", "succeeded");
  if (error) throw new Error(error.message);
  const rows = beforeRows || [];

  const d1CountBefore = Number(
    d1Execute(`SELECT COUNT(*) AS c FROM inventory_sync_ledger`)[0]?.c ?? -1,
  );
  const d1SucceededBefore = Number(
    d1Execute(
      `SELECT COUNT(*) AS c FROM inventory_sync_ledger WHERE status='succeeded'`,
    )[0]?.c ?? -1,
  );

  const categories: Record<string, number> = {};
  let mutationRisk = 0;

  for (const row of rows) {
    const { data: claimData, error: claimError } = await supabase.rpc(
      "claim_inventory_sync_ledger",
      {
        p_shop_id: row.shop_id,
        p_si_number: row.si_number,
        p_item_key: row.item_key,
        p_variant_id: row.variant_id,
        p_delta_quantity: row.delta_quantity,
        p_idempotency_key: row.idempotency_key,
      },
    );
    if (claimError) throw new Error(claimError.message);
    const primary = claimData as ClaimResult;
    if (primary.action !== "already_synced") mutationRisk += 1;

    const d1 = d1Execute(
      `SELECT id, shop_id, status, idempotency_key, variant_id, delta_quantity, shopify_adjustment_id
       FROM inventory_sync_ledger
       WHERE idempotency_key = ${sqlString(row.idempotency_key)}
       LIMIT 1`,
    )[0];

    const shadow: ClaimResult & { missing?: boolean } = !d1
      ? { action: "error", missing: true }
      : d1.status === "succeeded"
        ? { action: "already_synced" }
        : { action: "error", error_code: String(d1.status) };

    const category = classifyD1ShadowClaim(primary, shadow);
    categories[category] = (categories[category] || 0) + 1;

    const keysMatch =
      d1 &&
      String(d1.shop_id) === row.shop_id &&
      String(d1.status) === "succeeded" &&
      Number(d1.delta_quantity) === Number(row.delta_quantity) &&
      String(d1.variant_id) === String(row.variant_id);

    console.log(
      JSON.stringify({
        type: "d1_l2_acceptance_row",
        shop_id: row.shop_id,
        idempotency_key_prefix: String(row.idempotency_key).slice(0, 12),
        primary_action: primary.action,
        shadow_action: shadow.action,
        category,
        keys_match: Boolean(keysMatch),
      }),
    );
  }

  const { count: supabaseAfter } = await supabase
    .from("inventory_sync_ledger")
    .select("id", { count: "exact", head: true })
    .eq("status", "succeeded");

  const d1CountAfter = Number(
    d1Execute(`SELECT COUNT(*) AS c FROM inventory_sync_ledger`)[0]?.c ?? -1,
  );
  const d1Dup = Number(
    d1Execute(
      `SELECT COUNT(*) AS c FROM (
         SELECT idempotency_key FROM inventory_sync_ledger
         GROUP BY idempotency_key HAVING COUNT(*) > 1
       )`,
    )[0]?.c ?? 0,
  );

  const ok =
    rows.length === 2 &&
    categories.already_synced_match === 2 &&
    mutationRisk === 0 &&
    d1SucceededBefore === 2 &&
    d1CountAfter === d1CountBefore &&
    d1Dup === 0 &&
    supabaseAfter === 2;

  console.log(
    JSON.stringify({
      type: "d1_l2_acceptance_done",
      ok,
      supabase_succeeded: rows.length,
      d1_succeeded: d1SucceededBefore,
      d1_total_unchanged: d1CountAfter === d1CountBefore,
      d1_duplicate_idempotency: d1Dup,
      categories,
      inventory_mutation: 0,
      mutation_risk_claims: mutationRisk,
      note: "Shopify Admin inventory mutations were not invoked by this script",
    }),
  );

  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
