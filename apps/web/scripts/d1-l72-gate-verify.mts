/**
 * Stage L7.2: D1 primary pre-cutover gate verification.
 *
 * - Read-only Supabase ↔ D1 full row compare + field diff classification
 * - Ledger-layer production acceptance (Supabase RPC claim + D1 shadow claim write path)
 * - No Shopify inventory mutation; no INVSYNC_LEDGER_MODE / D1_LEDGER_MODE changes
 *
 * Usage (from apps/web):
 *   npx tsx --env-file=../../.env.local scripts/d1-l72-gate-verify.mts --remote
 *   npx tsx --env-file=../../.env.local scripts/d1-l72-gate-verify.mts --local
 */
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import * as bindings from "../app/lib/cloudflareBindings.server.ts";
import {
  classifyD1ShadowClaim,
  shadowClaimOnD1,
} from "../app/lib/d1LedgerShadow.server.ts";
import { createInventorySyncLedgerRepository } from "../app/lib/d1/inventorySyncLedger.server.ts";
import type { ClaimResult } from "../app/lib/syncLedger.server.ts";

const REMOTE = process.argv.includes("--remote") || !process.argv.includes("--local");
const targetFlag = REMOTE ? "--remote" : "--local";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type LedgerRow = {
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
  claim_token?: string | null;
  started_at: string | null;
  completed_at: string | null;
  shopify_adjustment_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
  claimed_at?: string | null;
  succeeded_at?: string | null;
  ambiguous_at?: string | null;
};

type DiffCategory =
  | "missing_in_d1"
  | "missing_in_supabase"
  | "idempotency_key"
  | "status"
  | "claim_token"
  | "attempt_count"
  | "shopify_refs"
  | "timestamps"
  | "error_info"
  | "identity"
  | "variant_delta"
  | "match";

const COMPARE_FIELDS: Array<{
  category: DiffCategory;
  supabase: keyof LedgerRow;
  d1: keyof LedgerRow;
  numeric?: boolean;
}> = [
  { category: "identity", supabase: "id", d1: "id" },
  { category: "identity", supabase: "shop_id", d1: "shop_id" },
  { category: "identity", supabase: "si_number", d1: "si_number" },
  { category: "identity", supabase: "item_key", d1: "item_key" },
  { category: "idempotency_key", supabase: "idempotency_key", d1: "idempotency_key" },
  { category: "status", supabase: "status", d1: "status" },
  { category: "attempt_count", supabase: "attempt_count", d1: "attempt_count", numeric: true },
  { category: "variant_delta", supabase: "variant_id", d1: "variant_id" },
  { category: "variant_delta", supabase: "delta_quantity", d1: "delta_quantity", numeric: true },
  { category: "shopify_refs", supabase: "inventory_item_id", d1: "inventory_item_id" },
  { category: "shopify_refs", supabase: "location_id", d1: "location_id" },
  { category: "shopify_refs", supabase: "shopify_adjustment_id", d1: "shopify_adjustment_id" },
  { category: "timestamps", supabase: "started_at", d1: "started_at" },
  { category: "timestamps", supabase: "completed_at", d1: "completed_at" },
  { category: "timestamps", supabase: "created_at", d1: "created_at" },
  { category: "timestamps", supabase: "updated_at", d1: "updated_at" },
  { category: "error_info", supabase: "error_code", d1: "error_code" },
  { category: "error_info", supabase: "error_message", d1: "error_message" },
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function norm(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function normNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function fetchAllD1(): LedgerRow[] {
  const rows = d1Execute(
    `SELECT id, shop_id, si_number, item_key, idempotency_key, variant_id,
            inventory_item_id, location_id, delta_quantity, status, attempt_count,
            claim_token, claimed_at, started_at, completed_at, succeeded_at, ambiguous_at,
            shopify_adjustment_id, error_code, error_message, created_at, updated_at
     FROM inventory_sync_ledger
     ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    shop_id: String(r.shop_id),
    si_number: String(r.si_number),
    item_key: String(r.item_key),
    idempotency_key: String(r.idempotency_key),
    variant_id: String(r.variant_id ?? ""),
    inventory_item_id: norm(r.inventory_item_id) || null,
    location_id: norm(r.location_id) || null,
    delta_quantity: Number(r.delta_quantity),
    status: String(r.status),
    attempt_count: Number(r.attempt_count ?? 0),
    claim_token: norm(r.claim_token) || null,
    started_at: norm(r.started_at) || null,
    completed_at: norm(r.completed_at) || null,
    shopify_adjustment_id: norm(r.shopify_adjustment_id) || null,
    error_code: norm(r.error_code) || null,
    error_message: norm(r.error_message) || null,
    created_at: norm(r.created_at) || null,
    updated_at: norm(r.updated_at) || null,
    claimed_at: norm(r.claimed_at) || null,
    succeeded_at: norm(r.succeeded_at) || null,
    ambiguous_at: norm(r.ambiguous_at) || null,
  }));
}

function compareRows(supabase: LedgerRow, d1: LedgerRow) {
  const fieldDiffs: Array<{ field: string; category: DiffCategory; supabase: string; d1: string }> = [];
  const categories = new Set<DiffCategory>();

  for (const spec of COMPARE_FIELDS) {
    const left = supabase[spec.supabase];
    const right = d1[spec.d1];
    const equal = spec.numeric
      ? normNum(left) === normNum(right)
      : norm(left) === norm(right);
    if (!equal) {
      fieldDiffs.push({
        field: String(spec.supabase),
        category: spec.category,
        supabase: norm(left),
        d1: norm(right),
      });
      categories.add(spec.category);
    }
  }

  const sbToken = norm(supabase.claim_token);
  const d1Token = norm(d1.claim_token);
  if (sbToken !== d1Token) {
    if (!fieldDiffs.some((d) => d.field === "claim_token")) {
      fieldDiffs.push({
        field: "claim_token",
        category: "claim_token",
        supabase: sbToken,
        d1: d1Token,
      });
      categories.add("claim_token");
    }
  }

  return { fieldDiffs, categories: [...categories] };
}

function expectedShadowActionFromStatus(
  status: string,
  primaryAction: string,
): ClaimResult["action"] {
  switch (status) {
    case "succeeded":
      return "already_synced";
    case "processing":
      return primaryAction === "claimed" ? "claimed" : "in_progress";
    case "ambiguous":
      return "manual_review";
    case "failed_terminal":
      return "terminal";
    case "pending":
    case "failed_retryable":
      return primaryAction === "claimed" ? "claimed" : "in_progress";
    default:
      return "error";
  }
}

function remoteD1Claim(row: LedgerRow): {
  action: ClaimResult["action"];
  status: string;
  claim_token: string | null;
} {
  const claimToken = `l72-gate-${crypto.randomUUID()}`;
  const ts = new Date().toISOString();

  d1Execute(
    `INSERT INTO inventory_sync_ledger (
       id, shop_id, si_number, item_key, idempotency_key, variant_id,
       delta_quantity, status, attempt_count, claim_token, claimed_at, started_at,
       created_at, updated_at, migration_source, migration_version, row_version
     ) VALUES (
       ${sqlString(crypto.randomUUID())},
       ${sqlString(row.shop_id)},
       ${sqlString(row.si_number)},
       ${sqlString(row.item_key)},
       ${sqlString(row.idempotency_key)},
       ${sqlString(row.variant_id)},
       ${Number(row.delta_quantity)},
       'processing', 1,
       ${sqlString(claimToken)},
       ${sqlString(ts)}, ${sqlString(ts)},
       ${sqlString(ts)}, ${sqlString(ts)},
       'shadow-gate', 'l72', 1
     ) ON CONFLICT(shop_id, si_number, item_key, idempotency_key) DO NOTHING`,
  );

  const selected = d1Execute(
    `SELECT status, claim_token, attempt_count FROM inventory_sync_ledger
     WHERE shop_id = ${sqlString(row.shop_id)}
       AND si_number = ${sqlString(row.si_number)}
       AND item_key = ${sqlString(row.item_key)}
       AND idempotency_key = ${sqlString(row.idempotency_key)}
     LIMIT 1`,
  )[0];

  if (!selected) {
    return { action: "error", status: "missing", claim_token: null };
  }

  const status = String(selected.status);
  const token = norm(selected.claim_token) || null;

  if (status === "succeeded") return { action: "already_synced", status, claim_token: token };
  if (status === "processing") {
    return {
      action: token === claimToken ? "claimed" : "in_progress",
      status,
      claim_token: token,
    };
  }
  if (status === "ambiguous") return { action: "manual_review", status, claim_token: token };
  if (status === "failed_terminal") return { action: "terminal", status, claim_token: token };
  if (status === "pending" || status === "failed_retryable") {
    d1Execute(
      `UPDATE inventory_sync_ledger
       SET status = 'processing',
           attempt_count = attempt_count + 1,
           claim_token = ${sqlString(claimToken)},
           claimed_at = ${sqlString(ts)},
           started_at = ${sqlString(ts)},
           updated_at = ${sqlString(ts)},
           row_version = row_version + 1
       WHERE shop_id = ${sqlString(row.shop_id)}
         AND si_number = ${sqlString(row.si_number)}
         AND item_key = ${sqlString(row.item_key)}
         AND idempotency_key = ${sqlString(row.idempotency_key)}
         AND status IN ('pending', 'failed_retryable')`,
    );
    const again = d1Execute(
      `SELECT status, claim_token FROM inventory_sync_ledger
       WHERE idempotency_key = ${sqlString(row.idempotency_key)} LIMIT 1`,
    )[0];
    const againStatus = String(again?.status ?? status);
    const againToken = norm(again?.claim_token) || null;
    if (againToken === claimToken) {
      return { action: "claimed", status: againStatus, claim_token: againToken };
    }
    return { action: "in_progress", status: againStatus, claim_token: againToken };
  }

  return { action: "error", status, claim_token: token };
}

async function runRemoteLedgerAcceptance(
  supabaseRows: LedgerRow[],
  supabase: ReturnType<typeof createClient>,
  d1Before: LedgerRow[],
) {
  const actionCategories: Record<string, number> = {};
  let mutationRisk = 0;
  let actionMismatch = 0;

  for (const row of supabaseRows) {
    const d1BeforeRow = d1Before.find((r) => r.idempotency_key === row.idempotency_key);

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
    if (primary.action === "claimed") mutationRisk += 1;

    const d1Claim = remoteD1Claim(row);
    const shadow: ClaimResult & { missing?: boolean } = {
      action: d1Claim.action,
      row: d1BeforeRow as ClaimResult["row"],
    };
    const category = classifyD1ShadowClaim(primary, shadow);
    actionCategories[category] = (actionCategories[category] || 0) + 1;

    if (
      category !== "already_synced_match" &&
      category !== "claimable_match" &&
      category !== "busy_match" &&
      category !== "ambiguous_match" &&
      category !== "terminal_match"
    ) {
      actionMismatch += 1;
    }

    console.log(
      JSON.stringify({
        type: "d1_l72_acceptance_row",
        idempotency_key_prefix: row.idempotency_key.slice(0, 12),
        primary_action: primary.action,
        primary_status: primary.row?.status ?? null,
        d1_status: d1Claim.status,
        shadow_action: d1Claim.action,
        shadow_category: category,
        mutation_risk: primary.action === "claimed",
        path: "remote_rpc_plus_d1_claim_sql",
      }),
    );
  }

  return { actionCategories, mutationRisk, actionMismatch };
}

async function runLocalShadowAcceptance(
  supabaseRows: LedgerRow[],
  supabase: ReturnType<typeof createClient>,
) {
  const proxy = await getPlatformProxy({
    configPath: join(webRoot, "wrangler.jsonc"),
    persist: true,
  });

  const db = (proxy.env as { TTI_DB: D1Database }).TTI_DB;
  if (!db) throw new Error("TTI_DB binding missing");

  const actionCategories: Record<string, number> = {};
  const shadowLogs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? "");
    if (line.includes("invsync_d1_shadow_diff")) shadowLogs.push(line);
    origLog(...args);
  };

  let mutationRisk = 0;
  let actionMismatch = 0;

  try {
    await bindings.runWithCloudflareEnv(
      { env: { TTI_DB: db } as Env, ctx: {} as ExecutionContext },
      async () => {
        const repo = createInventorySyncLedgerRepository(db);

        for (const row of supabaseRows) {
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
          if (primary.action === "claimed") mutationRisk += 1;

          const correlationId = crypto.randomUUID();
          await shadowClaimOnD1({
            correlationId,
            primary,
            shopId: row.shop_id,
            siNumber: row.si_number,
            itemKey: row.item_key,
            variantId: row.variant_id,
            deltaQuantity: row.delta_quantity,
            idempotencyKey: row.idempotency_key,
          });

          const d1AfterClaim = await repo.findByIdempotencyKey(row.idempotency_key);
          const shadowAction = d1AfterClaim
            ? expectedShadowActionFromStatus(d1AfterClaim.status, primary.action)
            : "error";
          const shadow: ClaimResult & { missing?: boolean } = {
            action: shadowAction,
            row: d1AfterClaim as unknown as ClaimResult["row"],
            missing: !d1AfterClaim,
          };

          const category = classifyD1ShadowClaim(primary, shadow);
          actionCategories[category] = (actionCategories[category] || 0) + 1;
          if (
            category !== "already_synced_match" &&
            category !== "claimable_match" &&
            category !== "busy_match" &&
            category !== "ambiguous_match" &&
            category !== "terminal_match"
          ) {
            actionMismatch += 1;
          }

          console.log(
            JSON.stringify({
              type: "d1_l72_acceptance_row",
              idempotency_key_prefix: row.idempotency_key.slice(0, 12),
              primary_action: primary.action,
              shadow_action: shadowAction,
              shadow_category: category,
              path: "local_shadowClaimOnD1",
            }),
          );
        }
      },
    );
  } finally {
    console.log = origLog;
    await proxy.dispose();
  }

  return {
    actionCategories,
    mutationRisk,
    actionMismatch,
    shadowLogs: shadowLogs.map((l) => JSON.parse(l)),
  };
}

async function main() {
  process.env.D1_LEDGER_MODE = "shadow";

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const { data: sbData, error: sbError } = await supabase
    .from("inventory_sync_ledger")
    .select(
      "id, shop_id, si_number, item_key, idempotency_key, variant_id, inventory_item_id, location_id, delta_quantity, status, attempt_count, started_at, completed_at, shopify_adjustment_id, error_code, error_message, created_at, updated_at",
    )
    .order("created_at", { ascending: true });

  if (sbError) throw new Error(sbError.message);
  const supabaseRows = (sbData || []) as LedgerRow[];
  const d1Before = fetchAllD1();

  const sbByIdem = new Map(supabaseRows.map((r) => [r.idempotency_key, r]));
  const d1ByIdem = new Map(d1Before.map((r) => [r.idempotency_key, r]));

  const categoryCounts: Record<string, number> = {};
  const rowReports: Array<Record<string, unknown>> = [];
  let errorDiffCount = 0;
  let stateDiffCount = 0;
  let missingInD1 = 0;
  let missingInSupabase = 0;

  for (const row of supabaseRows) {
    const d1 = d1ByIdem.get(row.idempotency_key);
    if (!d1) {
      missingInD1 += 1;
      categoryCounts.missing_in_d1 = (categoryCounts.missing_in_d1 || 0) + 1;
      rowReports.push({
        type: "d1_l72_row_compare",
        idempotency_key_prefix: row.idempotency_key.slice(0, 12),
        shop_id: row.shop_id,
        status: row.status,
        result: "missing_in_d1",
        backfill_candidate: row.status === "succeeded",
      });
      continue;
    }

    const { fieldDiffs, categories } = compareRows(row, d1);
    if (fieldDiffs.length === 0) {
      rowReports.push({
        type: "d1_l72_row_compare",
        idempotency_key_prefix: row.idempotency_key.slice(0, 12),
        result: "match",
      });
      categoryCounts.match = (categoryCounts.match || 0) + 1;
      continue;
    }

    for (const c of categories) {
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    }
    if (categories.some((c) => c === "error_info")) errorDiffCount += 1;
    if (categories.some((c) => ["status", "claim_token", "attempt_count"].includes(c))) {
      stateDiffCount += 1;
    }

    rowReports.push({
      type: "d1_l72_row_compare",
      idempotency_key_prefix: row.idempotency_key.slice(0, 12),
      shop_id: row.shop_id,
      result: "field_diff",
      categories,
      field_diffs: fieldDiffs,
    });
  }

  for (const row of d1Before) {
    if (!sbByIdem.has(row.idempotency_key)) {
      missingInSupabase += 1;
      categoryCounts.missing_in_supabase = (categoryCounts.missing_in_supabase || 0) + 1;
      rowReports.push({
        type: "d1_l72_row_compare",
        idempotency_key_prefix: row.idempotency_key.slice(0, 12),
        shop_id: row.shop_id,
        status: row.status,
        result: "missing_in_supabase",
      });
    }
  }

  for (const r of rowReports) {
    console.log(JSON.stringify(r));
  }

  console.log(
    JSON.stringify({
      type: "d1_l72_full_compare",
      target: REMOTE ? "remote" : "local",
      supabase_total: supabaseRows.length,
      d1_total: d1Before.length,
      missing_in_d1: missingInD1,
      missing_in_supabase: missingInSupabase,
      error_info_diff_rows: errorDiffCount,
      state_diff_rows: stateDiffCount,
      category_counts: categoryCounts,
    }),
  );

  // Ledger-layer acceptance: Supabase RPC + D1 shadow path (no Shopify inventory)
  const acceptance = REMOTE
    ? await runRemoteLedgerAcceptance(supabaseRows, supabase, d1Before)
    : await runLocalShadowAcceptance(supabaseRows, supabase);

  const d1After = fetchAllD1();
  const d1CountUnchanged = d1After.length === d1Before.length;

  const gateOk =
    missingInD1 === 0 &&
    missingInSupabase === 0 &&
    errorDiffCount === 0 &&
    stateDiffCount === 0 &&
    acceptance.mutationRisk === 0 &&
    acceptance.actionMismatch === 0 &&
    d1CountUnchanged;

  console.log(
    JSON.stringify({
      type: "d1_l72_acceptance_done",
      target: REMOTE ? "remote" : "local",
      rows_exercised: supabaseRows.length,
      mutation_risk_claims: acceptance.mutationRisk,
      action_mismatch: acceptance.actionMismatch,
      action_categories: acceptance.actionCategories,
      shadow_log_count:
        "shadowLogs" in acceptance ? acceptance.shadowLogs.length : 0,
      shadow_logs: "shadowLogs" in acceptance ? acceptance.shadowLogs : [],
      d1_row_count_unchanged: d1CountUnchanged,
      gate_ok: gateOk,
      inventory_mutation: 0,
      note: "Ledger-layer only; Shopify inventory not invoked",
    }),
  );

  console.log(
    JSON.stringify({
      type: "d1_l72_primary_readiness",
      ready_for_d1_primary: gateOk,
      blockers: [
        ...(missingInD1 ? ["missing_in_d1"] : []),
        ...(missingInSupabase ? ["missing_in_supabase"] : []),
        ...(errorDiffCount ? ["error_info_diff"] : []),
        ...(stateDiffCount ? ["state_diff"] : []),
        ...(acceptance.mutationRisk ? ["mutation_risk_on_claim"] : []),
        ...(acceptance.actionMismatch ? ["action_mismatch"] : []),
        ...(!d1CountUnchanged ? ["d1_row_count_changed"] : []),
      ],
    }),
  );

  if (!gateOk) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
