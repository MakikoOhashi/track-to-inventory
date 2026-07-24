/**
 * Read-only D1 schema verification (Stage L1).
 *
 * Local:  npm run d1:schema:check -- --local
 * Remote: npm run d1:schema:check -- --remote
 *
 * Does not write business data.
 */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const remote = process.argv.includes("--remote");
const targetFlag = remote ? "--remote" : "--local";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_TABLES = [
  "shops",
  "shipments",
  "shipment_items",
  "inventory_sync_ledger",
  "shopify_sessions",
  "shop_plans",
  "usage_counters",
  "notion_connections",
  "notion_oauth_states",
  "notion_provision_locks",
  "file_objects",
] as const;

function d1Execute(sql: string): string {
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
    {
      encoding: "utf8",
      cwd: webRoot,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `d1 execute failed (${targetFlag}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function parseRows(stdout: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(stdout) as Array<{
    results?: Array<Record<string, unknown>>;
    success?: boolean;
  }>;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first as { results?: Array<Record<string, unknown>> }).results ?? [];
}

function main() {
  console.log(
    JSON.stringify({
      type: "d1_schema_check_start",
      target: remote ? "remote" : "local",
    }),
  );

  const tables = parseRows(
    d1Execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ),
  ).map((r) => String(r.name));

  for (const name of EXPECTED_TABLES) {
    assert.ok(tables.includes(name), `missing table: ${name}`);
  }

  // Forbidden / deferred tables must not exist
  for (const name of [
    "ai_jobs",
    "ai_results",
    "ocr_jobs",
    "ocr_results",
    "deletion_jobs",
    "plans",
    "counters",
  ]) {
    assert.ok(!tables.includes(name), `unexpected table present: ${name}`);
  }

  const ledgerSql = parseRows(
    d1Execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory_sync_ledger'",
    ),
  )[0]?.sql;
  assert.ok(typeof ledgerSql === "string");
  assert.match(String(ledgerSql), /idempotency_key TEXT NOT NULL/);
  assert.match(String(ledgerSql), /claim_token/);
  assert.match(String(ledgerSql), /failed_retryable/);
  assert.match(String(ledgerSql), /UNIQUE/);

  const indexes = parseRows(
    d1Execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='inventory_sync_ledger'",
    ),
  ).map((r) => String(r.name));
  assert.ok(
    indexes.some((n) => n.includes("shop_si")),
    "ledger shop_si index missing",
  );

  const counts: Array<Record<string, unknown>> = [];
  for (const t of EXPECTED_TABLES) {
    const rows = parseRows(d1Execute(`SELECT '${t}' AS t, COUNT(*) AS c FROM ${t}`));
    counts.push(rows[0] ?? { t, c: -1 });
  }

  if (remote) {
    for (const row of counts) {
      assert.equal(
        Number(row.c),
        0,
        `production table ${row.t} must be empty (got ${row.c})`,
      );
    }
  }

  console.log(
    JSON.stringify({
      type: "d1_schema_check_ok",
      target: remote ? "remote" : "local",
      tables: EXPECTED_TABLES.length,
      indexes_ledger: indexes,
      row_counts: counts,
    }),
  );
}

main();
