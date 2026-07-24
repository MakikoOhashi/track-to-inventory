/**
 * Redis ledger Lua behavior tests (isolated keys under invsync:test:).
 * Run: node --experimental-strip-types scripts/k3-ledger-redis-tests.mts
 */
import assert from "node:assert/strict";
import { Redis } from "@upstash/redis";
import { createHash, randomUUID } from "node:crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

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

local function to_map(arr)
  local m = {}
  for i = 1, #arr, 2 do m[arr[i]] = arr[i+1] end
  return m
end

local existing = to_map(redis.call('HGETALL', key))
if next(existing) == nil then
  redis.call('HSET', key, 'id', newId, 'shop_id', shop, 'si_number', si, 'item_key', itemKey,
    'variant_id', variantId, 'delta_quantity', delta, 'idempotency_key', idem,
    'status', 'processing', 'attempt_count', '1', 'started_at', nowIso, 'claim_token', claimToken,
    'updated_at', nowIso)
  redis.call('SADD', siKey, key)
  return cjson.encode({ action = 'claimed', claim_token = claimToken, id = newId })
end
if existing.status == 'succeeded' then return cjson.encode({ action = 'already_synced' }) end
if existing.status == 'processing' then return cjson.encode({ action = 'in_progress', claim_token = existing.claim_token }) end
if existing.status == 'ambiguous' then return cjson.encode({ action = 'manual_review' }) end
if existing.status == 'failed_terminal' then return cjson.encode({ action = 'terminal' }) end
if existing.status == 'failed_retryable' or existing.status == 'pending' then
  redis.call('HSET', key, 'status', 'processing', 'attempt_count', tostring(tonumber(existing.attempt_count or '0')+1),
    'started_at', nowIso, 'claim_token', claimToken, 'updated_at', nowIso)
  return cjson.encode({ action = 'claimed', claim_token = claimToken })
end
return cjson.encode({ action = 'error', error_code = 'UNKNOWN_STATUS' })
`;

const FINALIZE_LUA = `
local key = KEYS[1]
local expectToken = ARGV[1]
local newStatus = ARGV[2]
local nowIso = ARGV[3]
local existing = {}
local arr = redis.call('HGETALL', key)
for i = 1, #arr, 2 do existing[arr[i]] = arr[i+1] end
if next(existing) == nil then return cjson.encode({ ok = false, reason = 'NOT_FOUND' }) end
if existing.status ~= 'processing' then return cjson.encode({ ok = false, reason = 'STATUS' }) end
if existing.claim_token ~= expectToken then return cjson.encode({ ok = false, reason = 'OWNER_MISMATCH' }) end
redis.call('HSET', key, 'status', newStatus, 'updated_at', nowIso, 'completed_at', nowIso, 'claim_token', '')
return cjson.encode({ ok = true })
`;

function parse(raw: unknown) {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function claim(key: string, siKey: string, shop: string, si: string, item: string, idem: string) {
  const token = randomUUID();
  const raw = await redis.eval(
    CLAIM_LUA,
    [key, siKey],
    [shop, si, item, "gid://v/1", "1", idem, randomUUID(), new Date().toISOString(), token],
  );
  return parse(raw);
}

async function finalize(key: string, token: string, status: string) {
  const raw = await redis.eval(FINALIZE_LUA, [key], [token, status, new Date().toISOString()]);
  return parse(raw);
}

const runId = createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 12);
const shop = "k3-test.myshopify.com";
const si = `K3-${runId}`;
const item = `item-${runId}`;
const idem = createHash("sha256").update(`${shop}|${si}|${item}`).digest("hex");
const key = `invsync:ledger:${encodeURIComponent(shop)}:${encodeURIComponent(si)}:${item}:${idem}`;
const siKey = `invsync:si:${encodeURIComponent(shop)}:${encodeURIComponent(si)}`;

try {
  // concurrent-ish sequential: first claimed, second in_progress
  const a = await claim(key, siKey, shop, si, item, idem);
  assert.equal(a.action, "claimed");
  const b = await claim(key, siKey, shop, si, item, idem);
  assert.equal(b.action, "in_progress");

  // owner mismatch finalize
  const bad = await finalize(key, "wrong-token", "succeeded");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "OWNER_MISMATCH");

  // success finalize
  const ok = await finalize(key, a.claim_token, "succeeded");
  assert.equal(ok.ok, true);

  // already synced
  const c = await claim(key, siKey, shop, si, item, idem);
  assert.equal(c.action, "already_synced");

  // ambiguous path
  const item2 = `${item}-2`;
  const idem2 = createHash("sha256").update(item2).digest("hex");
  const key2 = `invsync:ledger:${encodeURIComponent(shop)}:${encodeURIComponent(si)}:${item2}:${idem2}`;
  const d = await claim(key2, siKey, shop, si, item2, idem2);
  assert.equal(d.action, "claimed");
  const amb = await finalize(key2, d.claim_token, "ambiguous");
  assert.equal(amb.ok, true);
  const e = await claim(key2, siKey, shop, si, item2, idem2);
  assert.equal(e.action, "manual_review");

  // retryable reclaim
  const item3 = `${item}-3`;
  const idem3 = createHash("sha256").update(item3).digest("hex");
  const key3 = `invsync:ledger:${encodeURIComponent(shop)}:${encodeURIComponent(si)}:${item3}:${idem3}`;
  const f = await claim(key3, siKey, shop, si, item3, idem3);
  await finalize(key3, f.claim_token, "failed_retryable");
  const g = await claim(key3, siKey, shop, si, item3, idem3);
  assert.equal(g.action, "claimed");

  console.log("k3-ledger-redis-tests: ok");
} finally {
  const members = (await redis.smembers(siKey)) as string[];
  if (members.length) await redis.del(...members, siKey);
}
