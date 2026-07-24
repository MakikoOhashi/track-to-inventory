/**
 * Redis inventory sync ledger (Stage K3 / K3.6).
 * Namespace: tti:invsync:* (legacy invsync:* read-fallback until old keys retired).
 *
 * Stale processing policy (Stage I preserved):
 * - claim never auto-reclaims processing rows
 * - resolveStaleProcessing marks ambiguous (no Shopify retry)
 */

import { Redis } from "@upstash/redis";
import type {
  ClaimResult,
  LedgerClaimAction,
  LedgerRow,
  LedgerStatus,
} from "~/lib/syncLedger.server";
import {
  hgetallPreferNew,
  smembersPreferNew,
} from "~/lib/redisCompat.server";
import {
  invsyncLedgerKey,
  invsyncLedgerKeyLegacy,
  invsyncSiIndexKey,
  invsyncSiIndexKeyLegacy,
} from "~/lib/redisKeys.server";

export const INVSYNC_MIGRATION_VERSION = "k3-v1";

function redisClient(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Upstash Redis is not configured");
  }
  return new Redis({ url, token });
}

export function buildLedgerRedisKey(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  idempotencyKey: string;
}): string {
  return invsyncLedgerKey(params);
}

export function buildLedgerSiIndexKey(shopId: string, siNumber: string): string {
  return invsyncSiIndexKey(shopId, siNumber);
}

function rowFromHash(map: Record<string, string>): LedgerRow {
  return {
    id: map.id || "",
    shop_id: map.shop_id || "",
    si_number: map.si_number || "",
    item_key: map.item_key || "",
    variant_id: map.variant_id || "",
    inventory_item_id: map.inventory_item_id || null,
    location_id: map.location_id || null,
    delta_quantity: Number(map.delta_quantity),
    idempotency_key: map.idempotency_key || "",
    status: map.status as LedgerStatus,
    attempt_count: Number(map.attempt_count || 0),
    started_at: map.started_at || map.claimed_at || null,
    completed_at: map.completed_at || null,
    shopify_adjustment_id: map.shopify_adjustment_id || null,
    error_code: map.error_code || null,
    error_message: map.error_message || null,
    claim_token: map.claim_token || null,
  };
}

function parseEvalJson(raw: unknown): any {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { action: "error", error_code: "PARSE", raw: raw.slice(0, 200) };
    }
  }
  return { action: "error", error_code: "PARSE" };
}

const CLAIM_LUA = `
local key = KEYS[1]
local siKey = KEYS[2]
local shop = ARGV[1]
local si = ARGV[2]
local itemKey = ARGV[3]
local variantId = ARGV[4]
local delta = ARGV[5]
local idem = ARGV[6]
local newId = ARGV[7]
local nowIso = ARGV[8]
local claimToken = ARGV[9]
local syncItemId = ARGV[10]
local migrationVersion = ARGV[11]

local function to_map(arr)
  local m = {}
  for i = 1, #arr, 2 do
    m[arr[i]] = arr[i + 1]
  end
  return m
end

local function row_obj(m)
  return {
    id = m.id,
    shop_id = m.shop_id,
    si_number = m.si_number,
    item_key = m.item_key,
    variant_id = m.variant_id,
    inventory_item_id = m.inventory_item_id,
    location_id = m.location_id,
    delta_quantity = tonumber(m.delta_quantity),
    idempotency_key = m.idempotency_key,
    status = m.status,
    attempt_count = tonumber(m.attempt_count),
    started_at = m.started_at,
    completed_at = m.completed_at,
    shopify_adjustment_id = m.shopify_adjustment_id,
    error_code = m.error_code,
    error_message = m.error_message,
    claim_token = m.claim_token
  }
end

local existing = to_map(redis.call('HGETALL', key))
if next(existing) == nil then
  redis.call('HSET', key,
    'id', newId,
    'shop_id', shop,
    'si_number', si,
    'item_key', itemKey,
    'sync_item_id', syncItemId,
    'variant_id', variantId,
    'inventory_item_id', '',
    'location_id', '',
    'delta_quantity', delta,
    'idempotency_key', idem,
    'status', 'processing',
    'attempt_count', '1',
    'started_at', nowIso,
    'claimed_at', nowIso,
    'completed_at', '',
    'succeeded_at', '',
    'ambiguous_at', '',
    'shopify_adjustment_id', '',
    'error_code', '',
    'error_message', '',
    'claim_token', claimToken,
    'created_at', nowIso,
    'updated_at', nowIso,
    'migration_source', 'runtime',
    'migration_version', migrationVersion
  )
  redis.call('SADD', siKey, key)
  return cjson.encode({ action = 'claimed', row = row_obj(to_map(redis.call('HGETALL', key))) })
end

local status = existing.status
if status == 'succeeded' then
  return cjson.encode({ action = 'already_synced', row = row_obj(existing) })
end
if status == 'processing' then
  -- Stage I: never auto-reclaim; caller may mark stale → ambiguous
  return cjson.encode({ action = 'in_progress', row = row_obj(existing) })
end
if status == 'ambiguous' then
  return cjson.encode({ action = 'manual_review', row = row_obj(existing) })
end
if status == 'failed_terminal' then
  return cjson.encode({ action = 'terminal', row = row_obj(existing) })
end
if status == 'failed_retryable' or status == 'pending' then
  local attempts = tonumber(existing.attempt_count or '0') + 1
  redis.call('HSET', key,
    'status', 'processing',
    'attempt_count', tostring(attempts),
    'started_at', nowIso,
    'claimed_at', nowIso,
    'updated_at', nowIso,
    'variant_id', variantId,
    'delta_quantity', delta,
    'error_code', '',
    'error_message', '',
    'claim_token', claimToken,
    'completed_at', '',
    'succeeded_at', '',
    'ambiguous_at', ''
  )
  redis.call('SADD', siKey, key)
  return cjson.encode({ action = 'claimed', row = row_obj(to_map(redis.call('HGETALL', key))) })
end

return cjson.encode({ action = 'error', error_code = 'UNKNOWN_STATUS', row = row_obj(existing) })
`;

const FINALIZE_LUA = `
local key = KEYS[1]
local expectToken = ARGV[1]
local newStatus = ARGV[2]
local nowIso = ARGV[3]
local inventoryItemId = ARGV[4]
local locationId = ARGV[5]
local shopifyAdjustmentId = ARGV[6]
local errorCode = ARGV[7]
local errorMessage = ARGV[8]

local function to_map(arr)
  local m = {}
  for i = 1, #arr, 2 do
    m[arr[i]] = arr[i + 1]
  end
  return m
end

local existing = to_map(redis.call('HGETALL', key))
if next(existing) == nil then
  return cjson.encode({ ok = false, reason = 'NOT_FOUND' })
end
if existing.status ~= 'processing' then
  return cjson.encode({ ok = false, reason = 'STATUS', status = existing.status })
end
if existing.claim_token ~= expectToken then
  return cjson.encode({ ok = false, reason = 'OWNER_MISMATCH' })
end

redis.call('HSET', key,
  'status', newStatus,
  'updated_at', nowIso,
  'completed_at', nowIso,
  'inventory_item_id', inventoryItemId,
  'location_id', locationId,
  'shopify_adjustment_id', shopifyAdjustmentId,
  'error_code', errorCode,
  'error_message', errorMessage
)

if newStatus == 'succeeded' then
  redis.call('HSET', key, 'succeeded_at', nowIso, 'ambiguous_at', '', 'error_code', '', 'error_message', '')
elseif newStatus == 'ambiguous' then
  redis.call('HSET', key, 'ambiguous_at', nowIso)
end

-- clear claim token after finalize so stale finalize cannot overwrite
redis.call('HSET', key, 'claim_token', '')

return cjson.encode({ ok = true })
`;

const SIMULATE_CLAIM_LUA = `
local key = KEYS[1]
local function to_map(arr)
  local m = {}
  for i = 1, #arr, 2 do
    m[arr[i]] = arr[i + 1]
  end
  return m
end
local function row_obj(m)
  return {
    id = m.id,
    shop_id = m.shop_id,
    si_number = m.si_number,
    item_key = m.item_key,
    variant_id = m.variant_id,
    inventory_item_id = m.inventory_item_id,
    location_id = m.location_id,
    delta_quantity = tonumber(m.delta_quantity),
    idempotency_key = m.idempotency_key,
    status = m.status,
    attempt_count = tonumber(m.attempt_count),
    started_at = m.started_at,
    completed_at = m.completed_at,
    shopify_adjustment_id = m.shopify_adjustment_id,
    error_code = m.error_code,
    error_message = m.error_message,
    claim_token = m.claim_token
  }
end
local existing = to_map(redis.call('HGETALL', key))
if next(existing) == nil then
  return cjson.encode({ action = 'claimed', missing = true })
end
local status = existing.status
if status == 'succeeded' then
  return cjson.encode({ action = 'already_synced', row = row_obj(existing) })
end
if status == 'processing' then
  return cjson.encode({ action = 'in_progress', row = row_obj(existing) })
end
if status == 'ambiguous' then
  return cjson.encode({ action = 'manual_review', row = row_obj(existing) })
end
if status == 'failed_terminal' then
  return cjson.encode({ action = 'terminal', row = row_obj(existing) })
end
if status == 'failed_retryable' or status == 'pending' then
  return cjson.encode({ action = 'claimed', row = row_obj(existing) })
end
return cjson.encode({ action = 'error', error_code = 'UNKNOWN_STATUS' })
`;

function normalizeRow(row: any): LedgerRow | undefined {
  if (!row || typeof row !== "object") return undefined;
  const normalized: LedgerRow = {
    id: String(row.id || ""),
    shop_id: String(row.shop_id || ""),
    si_number: String(row.si_number || ""),
    item_key: String(row.item_key || ""),
    variant_id: String(row.variant_id || ""),
    inventory_item_id: row.inventory_item_id ? String(row.inventory_item_id) : null,
    location_id: row.location_id ? String(row.location_id) : null,
    delta_quantity: Number(row.delta_quantity),
    idempotency_key: String(row.idempotency_key || ""),
    status: row.status as LedgerStatus,
    attempt_count: Number(row.attempt_count || 0),
    started_at: row.started_at ? String(row.started_at) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    shopify_adjustment_id: row.shopify_adjustment_id
      ? String(row.shopify_adjustment_id)
      : null,
    error_code: row.error_code ? String(row.error_code) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    claim_token: row.claim_token ? String(row.claim_token) : null,
  };
  // empty strings from Redis → nulls
  if (!normalized.inventory_item_id) normalized.inventory_item_id = null;
  if (!normalized.location_id) normalized.location_id = null;
  if (!normalized.shopify_adjustment_id) normalized.shopify_adjustment_id = null;
  if (!normalized.error_code) normalized.error_code = null;
  if (!normalized.error_message) normalized.error_message = null;
  if (!normalized.claim_token) normalized.claim_token = null;
  if (!normalized.started_at) normalized.started_at = null;
  if (!normalized.completed_at) normalized.completed_at = null;
  return normalized;
}

export async function claimInventorySyncLedgerRedis(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  variantId: string;
  deltaQuantity: number;
  idempotencyKey: string;
}): Promise<ClaimResult> {
  const r = redisClient();
  const key = invsyncLedgerKey(params);
  const legacyKey = invsyncLedgerKeyLegacy(params);
  // Hydrate new key from legacy succeeded/etc. before claim so shadow stays consistent
  const existingNew = await r.exists(key);
  if (!existingNew) {
    const legacy = await r.hgetall(legacyKey);
    if (legacy && Object.keys(legacy as object).length > 0) {
      await r.hset(key, legacy as Record<string, unknown>);
      const legacySi = invsyncSiIndexKeyLegacy(params.shopId, params.siNumber);
      const siKeyNew = invsyncSiIndexKey(params.shopId, params.siNumber);
      await r.sadd(siKeyNew, key);
      void legacySi;
    }
  }
  const siKey = invsyncSiIndexKey(params.shopId, params.siNumber);
  const nowIso = new Date().toISOString();
  const newId = crypto.randomUUID();
  const claimToken = crypto.randomUUID();

  let raw: unknown;
  try {
    raw = await r.eval(
      CLAIM_LUA,
      [key, siKey],
      [
        params.shopId,
        params.siNumber,
        params.itemKey,
        params.variantId,
        String(params.deltaQuantity),
        params.idempotencyKey,
        newId,
        nowIso,
        claimToken,
        params.itemKey,
        INVSYNC_MIGRATION_VERSION,
      ],
    );
  } catch (error) {
    throw new Error(
      `Redis ledger claim failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = parseEvalJson(raw);
  if (!parsed || typeof parsed.action !== "string") {
    return { action: "error", error_code: "PARSE" };
  }

  return {
    action: parsed.action as LedgerClaimAction,
    row: normalizeRow(parsed.row),
    error_code: parsed.error_code,
  };
}

/** Read-only claim prediction for shadow diffs (no writes). */
export async function simulateClaimInventorySyncLedgerRedis(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  idempotencyKey: string;
}): Promise<ClaimResult & { missing?: boolean }> {
  const r = redisClient();
  const key = invsyncLedgerKey(params);
  const legacyKey = invsyncLedgerKeyLegacy(params);
  // Simulate against new key if present, else legacy (read-only)
  const prefer = (await r.exists(key)) ? key : legacyKey;
  let raw: unknown;
  try {
    raw = await r.eval(SIMULATE_CLAIM_LUA, [prefer], []);
  } catch (error) {
    throw new Error(
      `Redis ledger simulate failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseEvalJson(raw);
  return {
    action: (parsed?.action || "error") as LedgerClaimAction,
    row: normalizeRow(parsed?.row),
    error_code: parsed?.error_code,
    missing: Boolean(parsed?.missing),
  };
}

export async function finalizeLedgerRedis(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  idempotencyKey: string;
  claimToken: string;
  status: "succeeded" | "failed_retryable" | "failed_terminal" | "ambiguous";
  inventoryItemId?: string | null;
  locationId?: string | null;
  shopifyAdjustmentId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!params.claimToken) {
    return { ok: false, reason: "MISSING_TOKEN" };
  }
  const r = redisClient();
  const key = invsyncLedgerKey(params);
  const nowIso = new Date().toISOString();

  let raw: unknown;
  try {
    raw = await r.eval(
      FINALIZE_LUA,
      [key],
      [
        params.claimToken,
        params.status,
        nowIso,
        params.inventoryItemId || "",
        params.locationId || "",
        params.shopifyAdjustmentId || "",
        params.errorCode || "",
        (params.errorMessage || "").slice(0, 2000),
      ],
    );
  } catch (error) {
    throw new Error(
      `Redis ledger finalize failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = parseEvalJson(raw);
  return { ok: Boolean(parsed?.ok), reason: parsed?.reason };
}

export async function markStaleProcessingRedis(row: LedgerRow): Promise<LedgerRow> {
  if (row.status !== "processing" || !row.started_at || !row.claim_token) {
    // Migrated succeeded rows have no claim_token; stale path needs token from live claim
  }
  if (row.status !== "processing" || !row.started_at) return row;

  // Use claim_token when present; otherwise refuse reclaim and leave unchanged
  // (fail-closed: cannot safely CAS without owner)
  if (!row.claim_token) {
    return row;
  }

  const result = await finalizeLedgerRedis({
    shopId: row.shop_id,
    siNumber: row.si_number,
    itemKey: row.item_key,
    idempotencyKey: row.idempotency_key,
    claimToken: row.claim_token,
    status: "ambiguous",
    errorCode: "STALE_PROCESSING",
    errorMessage:
      "Processing exceeded stale window; Shopify outcome unknown. Manual review required.",
    inventoryItemId: row.inventory_item_id,
    locationId: row.location_id,
  });

  if (!result.ok) return row;

  return {
    ...row,
    status: "ambiguous",
    error_code: "STALE_PROCESSING",
    error_message:
      "Processing exceeded stale window; Shopify outcome unknown. Manual review required.",
    completed_at: new Date().toISOString(),
    claim_token: null,
  };
}

export async function getLedgerHash(
  params: {
    shopId: string;
    siNumber: string;
    itemKey: string;
    idempotencyKey: string;
  },
): Promise<Record<string, string> | null> {
  const r = redisClient();
  return hgetallPreferNew(
    r,
    invsyncLedgerKey(params),
    invsyncLedgerKeyLegacy(params),
  );
}

export async function listLedgerForShipmentRedis(params: {
  shopId: string;
  siNumber: string;
}): Promise<LedgerRow[]> {
  const r = redisClient();
  const keys = await smembersPreferNew(
    r,
    invsyncSiIndexKey(params.shopId, params.siNumber),
    invsyncSiIndexKeyLegacy(params.shopId, params.siNumber),
  );
  if (!keys.length) return [];

  const rows: LedgerRow[] = [];
  for (const key of keys) {
    // Members may be legacy or new ledger keys during migration
    const map = (await r.hgetall(key)) as Record<string, string> | null;
    if (!map || !map.status) continue;
    const row = rowFromHash(map);
    if (row.shop_id === params.shopId && row.si_number === params.siNumber) {
      rows.push(row);
    }
  }
  return rows;
}

/** Write a full ledger hash (migration). Does not overwrite mismatched existing rows. */
export async function putLedgerHashIfCompatible(
  fields: Record<string, string>,
  opts: { overwriteIdentical: boolean },
): Promise<"inserted" | "skipped_identical" | "conflict"> {
  const key = invsyncLedgerKey({
    shopId: fields.shop_id,
    siNumber: fields.si_number,
    itemKey: fields.item_key,
    idempotencyKey: fields.idempotency_key,
  });
  const siKey = invsyncSiIndexKey(fields.shop_id, fields.si_number);
  const r = redisClient();
  const existing = (await r.hgetall(key)) as Record<string, string> | null;

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
    for (const k of compareKeys) {
      const a = String(existing[k] ?? "");
      const b = String(fields[k] ?? "");
      if (a !== b) {
        return "conflict";
      }
    }
    if (!opts.overwriteIdentical) return "skipped_identical";
  }

  await r.hset(key, fields);
  await r.sadd(siKey, key);
  return existing && Object.keys(existing).length > 0
    ? "skipped_identical"
    : "inserted";
}

export type ShadowDiffClass =
  | "claim_match"
  | "already_synced_match"
  | "busy_match"
  | "ambiguous_match"
  | "record_missing"
  | "status_mismatch"
  | "key_mismatch"
  | "action_mismatch";

export function classifyShadowDiff(
  primary: ClaimResult,
  shadow: ClaimResult & { missing?: boolean },
): ShadowDiffClass {
  if (shadow.missing && primary.action === "claimed") return "record_missing";
  if (shadow.missing && primary.action !== "claimed") return "record_missing";

  if (primary.action === shadow.action) {
    if (primary.action === "claimed") return "claim_match";
    if (primary.action === "already_synced") return "already_synced_match";
    if (primary.action === "in_progress") return "busy_match";
    if (primary.action === "manual_review") return "ambiguous_match";
    return "claim_match";
  }

  if (
    primary.row &&
    shadow.row &&
    primary.row.idempotency_key !== shadow.row.idempotency_key
  ) {
    return "key_mismatch";
  }
  if (primary.row && shadow.row && primary.row.status !== shadow.row.status) {
    return "status_mismatch";
  }
  return "action_mismatch";
}

/** Safe structured log — never includes tokens or PII documents. */
export function logShadowDiff(payload: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  idempotencyKeyPrefix: string;
  primaryAction: string;
  shadowAction: string;
  classification: ShadowDiffClass;
}): void {
  console.log(
    JSON.stringify({
      type: "invsync_shadow_diff",
      ...payload,
    }),
  );
}
