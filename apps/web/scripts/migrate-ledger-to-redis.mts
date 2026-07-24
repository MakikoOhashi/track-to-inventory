/**
 * Migrate inventory_sync_ledger rows from Supabase → Upstash Redis.
 *
 * Usage (from apps/web):
 *   node --experimental-strip-types scripts/migrate-ledger-to-redis.mts --dry-run
 *   node --experimental-strip-types scripts/migrate-ledger-to-redis.mts --apply
 */
import { createClient } from "@supabase/supabase-js";
import { Redis } from "@upstash/redis";

const DRY_RUN = process.argv.includes("--dry-run") || !process.argv.includes("--apply");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function buildLedgerRedisKey(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  idempotencyKey: string;
}): string {
  return [
    "tti:invsync:ledger",
    encodeURIComponent(params.shopId),
    encodeURIComponent(params.siNumber),
    params.itemKey,
    params.idempotencyKey,
  ].join(":");
}

function buildLedgerSiIndexKey(shopId: string, siNumber: string): string {
  return `tti:invsync:si:${encodeURIComponent(shopId)}:${encodeURIComponent(siNumber)}`;
}

function rowToFields(row: any): Record<string, string> {
  const completed = row.completed_at || "";
  const status = row.status || "";
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    si_number: String(row.si_number),
    item_key: String(row.item_key),
    sync_item_id: String(row.item_key),
    variant_id: String(row.variant_id || ""),
    inventory_item_id: row.inventory_item_id ? String(row.inventory_item_id) : "",
    location_id: row.location_id ? String(row.location_id) : "",
    delta_quantity: String(row.delta_quantity),
    idempotency_key: String(row.idempotency_key),
    status,
    attempt_count: String(row.attempt_count ?? 0),
    started_at: row.started_at ? String(row.started_at) : "",
    claimed_at: row.started_at ? String(row.started_at) : "",
    completed_at: completed,
    succeeded_at: status === "succeeded" ? completed : "",
    ambiguous_at: status === "ambiguous" ? completed : "",
    shopify_adjustment_id: row.shopify_adjustment_id
      ? String(row.shopify_adjustment_id)
      : "",
    error_code: row.error_code ? String(row.error_code) : "",
    error_message: row.error_message ? String(row.error_message) : "",
    claim_token: "",
    created_at: row.created_at ? String(row.created_at) : new Date().toISOString(),
    updated_at: row.updated_at ? String(row.updated_at) : new Date().toISOString(),
    migration_source: "supabase",
    migration_version: "k3-v1",
  };
}

async function main() {
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const { data: rows, error } = await supabase
    .from("inventory_sync_ledger")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  const list = rows || [];

  const statusCounts: Record<string, number> = {};
  for (const r of list) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  console.log(
    JSON.stringify(
      {
        mode: DRY_RUN ? "dry-run" : "apply",
        supabaseCount: list.length,
        statusCounts,
        keys: list.map((r) =>
          buildLedgerRedisKey({
            shopId: r.shop_id,
            siNumber: r.si_number,
            itemKey: r.item_key,
            idempotencyKey: r.idempotency_key,
          }),
        ),
      },
      null,
      2,
    ),
  );

  const results = {
    inserted: 0,
    skipped_identical: 0,
    conflict: 0,
    conflicts: [] as Array<{ key: string; id: string }>,
  };

  for (const row of list) {
    const fields = rowToFields(row);
    const key = buildLedgerRedisKey({
      shopId: fields.shop_id,
      siNumber: fields.si_number,
      itemKey: fields.item_key,
      idempotencyKey: fields.idempotency_key,
    });
    const siKey = buildLedgerSiIndexKey(fields.shop_id, fields.si_number);

    const existing = (await redis.hgetall(key)) as Record<string, string> | null;
    if (existing && Object.keys(existing).length > 0) {
      const compareKeys = [
        "id",
        "shop_id",
        "si_number",
        "item_key",
        "idempotency_key",
        "status",
        "delta_quantity",
        "variant_id",
        "shopify_adjustment_id",
      ];
      let conflict = false;
      for (const k of compareKeys) {
        if (String(existing[k] ?? "") !== String(fields[k] ?? "")) {
          conflict = true;
          break;
        }
      }
      if (conflict) {
        results.conflict += 1;
        results.conflicts.push({ key, id: fields.id });
        continue;
      }
      results.skipped_identical += 1;
      continue;
    }

    if (DRY_RUN) {
      results.inserted += 1;
      continue;
    }

    await redis.hset(key, fields);
    await redis.sadd(siKey, key);
    results.inserted += 1;
  }

  if (results.conflict > 0) {
    console.error(
      JSON.stringify({ error: "CONFLICT", ...results }, null, 2),
    );
    process.exit(2);
  }

  // Post-check counts from Redis SI indexes
  const redisStatus: Record<string, number> = {};
  let redisCount = 0;
  for (const row of list) {
    const key = buildLedgerRedisKey({
      shopId: row.shop_id,
      siNumber: row.si_number,
      itemKey: row.item_key,
      idempotencyKey: row.idempotency_key,
    });
    if (DRY_RUN) continue;
    const map = (await redis.hgetall(key)) as Record<string, string> | null;
    if (map?.status) {
      redisCount += 1;
      redisStatus[map.status] = (redisStatus[map.status] || 0) + 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: DRY_RUN ? "dry-run" : "apply",
        results,
        redisAfter: DRY_RUN ? null : { redisCount, redisStatus },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
