/**
 * Stage L4.0 — read-only Shopify session audit (Redis new vs legacy).
 *
 *   npx tsx --env-file=.env.local scripts/session-l40-audit.mts
 *
 * Never writes Redis / production D1. Never prints accessToken, state, or raw payload.
 */
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { Session } from "@shopify/shopify-api";

type StoredSessionPayload = {
  entries: [string, string | number | boolean][];
  shop: string;
  expiresAt?: number;
};

type Namespace = "new" | "legacy";

type SessionMeta = {
  namespace: Namespace;
  session_id_hash: string;
  session_id_kind: "offline" | "online" | "other";
  shop: string;
  is_online: boolean | null;
  expires_ms: number | null;
  expires_iso: string | null;
  expired: boolean | null;
  has_user_id: boolean;
  has_access_token: boolean;
  scope_present: boolean;
  scope_hash: string | null;
  entry_keys: string[];
  payload_shape_ok: boolean;
  ttl_seconds: number | null;
  redis_key_masked: string;
  parse_error?: string;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function hashScope(scope: string | undefined): string | null {
  if (!scope) return null;
  return createHash("sha256").update(scope).digest("hex").slice(0, 12);
}

function maskKey(key: string): string {
  return key
    .replace(/[a-z0-9][a-z0-9-]*\.myshopify\.com/gi, "<shop>")
    .replace(/offline_[^:]+/g, "offline_<shop>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/[0-9a-f]{32,}/gi, "<hex>");
}

function assertNoSecrets(obj: unknown): void {
  const s = JSON.stringify(obj);
  if (/shpat_|shpss_|accessToken|\"state\":/i.test(s) && /shpat_|shpss_/.test(s)) {
    throw new Error("secret leakage detected in audit output");
  }
  // state field name alone in entry_keys is ok; raw state values must not appear
  if (/\"state\":\"[^"]{8,}\"/i.test(s)) {
    throw new Error("state value leakage detected");
  }
}

function sessionIdKind(id: string): "offline" | "online" | "other" {
  if (id.startsWith("offline_")) return "offline";
  if (/^[0-9a-f-]{36}$/i.test(id) || id.includes(".")) return "online";
  return "other";
}

function extractSessionId(key: string, namespace: Namespace): string | null {
  const prefix =
    namespace === "new" ? "tti:shopify:session:" : "shopify:session:";
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length);
}

async function scanKeys(redis: Redis, match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [next, batch] = (await redis.scan(cursor, {
      match,
      count: 200,
    })) as [string | number, string[]];
    cursor = Number(next);
    keys.push(...(batch || []));
  } while (cursor !== 0);
  return [...new Set(keys)];
}

function analyzePayload(
  payload: unknown,
  namespace: Namespace,
  sessionId: string,
  redisKey: string,
  ttl: number | null,
): SessionMeta {
  const base: SessionMeta = {
    namespace,
    session_id_hash: hashId(sessionId),
    session_id_kind: sessionIdKind(sessionId),
    shop: "",
    is_online: null,
    expires_ms: null,
    expires_iso: null,
    expired: null,
    has_user_id: false,
    has_access_token: false,
    scope_present: false,
    scope_hash: null,
    entry_keys: [],
    payload_shape_ok: false,
    ttl_seconds: ttl != null && ttl >= 0 ? ttl : ttl === -1 ? -1 : null,
    redis_key_masked: maskKey(redisKey),
  };

  if (!payload || typeof payload !== "object") {
    return { ...base, parse_error: "not_object" };
  }

  const p = payload as StoredSessionPayload;
  if (!Array.isArray(p.entries)) {
    return { ...base, shop: String(p.shop || ""), parse_error: "missing_entries" };
  }

  base.payload_shape_ok = true;
  base.shop = String(p.shop || "");
  base.entry_keys = p.entries.map(([k]) => String(k)).sort();

  try {
    const session = Session.fromPropertyArray(p.entries, true);
    base.shop = session.shop || base.shop;
    base.is_online = Boolean(session.isOnline);
    base.has_access_token = Boolean(session.accessToken);
    base.scope_present = Boolean(session.scope);
    base.scope_hash = hashScope(session.scope);
    const onlineInfo = (session as { onlineAccessInfo?: { associated_user?: { id?: number } } })
      .onlineAccessInfo;
    base.has_user_id = Boolean(onlineInfo?.associated_user?.id);
    if (session.expires) {
      base.expires_ms = session.expires.getTime();
      base.expires_iso = session.expires.toISOString();
      base.expired = base.expires_ms <= Date.now();
    } else if (typeof p.expiresAt === "number") {
      base.expires_ms = p.expiresAt;
      base.expires_iso = new Date(p.expiresAt).toISOString();
      base.expired = p.expiresAt <= Date.now();
    } else {
      base.expired = false; // offline / no expiry
    }
  } catch (error) {
    return {
      ...base,
      parse_error: error instanceof Error ? error.message.slice(0, 80) : "parse_failed",
    };
  }

  return base;
}

function semanticFingerprint(meta: SessionMeta, payload: StoredSessionPayload): string {
  // Compare meaningful fields without secret values
  let session: Session;
  try {
    session = Session.fromPropertyArray(payload.entries, true);
  } catch {
    return `invalid:${meta.session_id_hash}`;
  }
  return [
    session.id,
    session.shop,
    String(session.isOnline),
    session.scope || "",
    session.expires ? String(session.expires.getTime()) : "",
    session.accessToken ? "token:yes" : "token:no",
    meta.entry_keys.join(","),
  ].join("|");
}

function comparePair(
  id: string,
  neu: { meta: SessionMeta; payload: StoredSessionPayload } | null,
  legacy: { meta: SessionMeta; payload: StoredSessionPayload } | null,
): string {
  if (neu && !legacy) return "only_in_new";
  if (!neu && legacy) return "only_in_legacy";
  if (!neu || !legacy) return "invalid_session";
  if (neu.meta.parse_error || legacy.meta.parse_error) return "invalid_session";

  const a = semanticFingerprint(neu.meta, neu.payload);
  const b = semanticFingerprint(legacy.meta, legacy.payload);
  if (a === b) {
    // JSON may still differ in key order
    return "identical";
  }

  // Same id/shop/online/token presence/scope/expires → semantically_equivalent
  try {
    const sNew = Session.fromPropertyArray(neu.payload.entries, true);
    const sOld = Session.fromPropertyArray(legacy.payload.entries, true);
    const sameCore =
      sNew.id === sOld.id &&
      sNew.shop === sOld.shop &&
      sNew.isOnline === sOld.isOnline &&
      (sNew.scope || "") === (sOld.scope || "") &&
      Boolean(sNew.accessToken) === Boolean(sOld.accessToken) &&
      (sNew.expires?.getTime() ?? null) === (sOld.expires?.getTime() ?? null);
    if (sameCore) {
      const keysNew = [...neu.meta.entry_keys].sort().join(",");
      const keysOld = [...legacy.meta.entry_keys].sort().join(",");
      if (keysNew !== keysOld) return "serializer_mismatch";
      return "semantically_equivalent";
    }
    if (
      (sNew.expires?.getTime() ?? null) !== (sOld.expires?.getTime() ?? null) &&
      sNew.shop === sOld.shop &&
      sNew.isOnline === sOld.isOnline
    ) {
      return "expiry_mismatch";
    }
    return "payload_mismatch";
  } catch {
    return "invalid_session";
  }
}

async function main() {
  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });

  const newSessionKeys = await scanKeys(redis, "tti:shopify:session:*");
  const legacySessionKeys = await scanKeys(redis, "shopify:session:*");
  // Exclude tti: prefixed from legacy scan if SCAN somehow overlaps (it shouldn't)
  const legacyOnly = legacySessionKeys.filter((k) => !k.startsWith("tti:"));

  const newShopSets = await scanKeys(redis, "tti:shopify:shop-sessions:*");
  const legacyShopSets = (await scanKeys(redis, "shopify:shop-sessions:*")).filter(
    (k) => !k.startsWith("tti:"),
  );

  const byId: Record<
    string,
    {
      new?: { meta: SessionMeta; payload: StoredSessionPayload };
      legacy?: { meta: SessionMeta; payload: StoredSessionPayload };
    }
  > = {};

  for (const key of newSessionKeys) {
    const id = extractSessionId(key, "new");
    if (!id) continue;
    const payload = await redis.get(key);
    const ttl = await redis.ttl(key);
    const meta = analyzePayload(payload, "new", id, key, ttl);
    byId[id] = byId[id] || {};
    byId[id].new = {
      meta,
      payload: payload as StoredSessionPayload,
    };
  }

  for (const key of legacyOnly) {
    const id = extractSessionId(key, "legacy");
    if (!id) continue;
    const payload = await redis.get(key);
    const ttl = await redis.ttl(key);
    const meta = analyzePayload(payload, "legacy", id, key, ttl);
    byId[id] = byId[id] || {};
    byId[id].legacy = {
      meta,
      payload: payload as StoredSessionPayload,
    };
  }

  const classifications: Record<string, number> = {};
  const pairResults: Array<{
    session_id_hash: string;
    shop: string;
    classification: string;
    kind: string;
    seed_candidate: boolean;
    seed_exclude_reason?: string;
  }> = [];

  for (const [id, pair] of Object.entries(byId)) {
    const classification = comparePair(id, pair.new ?? null, pair.legacy ?? null);
    classifications[classification] = (classifications[classification] || 0) + 1;

    const meta = pair.new?.meta || pair.legacy?.meta!;
    let seed_candidate = false;
    let seed_exclude_reason: string | undefined;

    if (classification === "payload_mismatch" || classification === "serializer_mismatch") {
      seed_exclude_reason = "mismatch_stop";
    } else if (classification === "invalid_session") {
      seed_exclude_reason = "invalid";
    } else if (meta.expired) {
      seed_exclude_reason = "expired";
    } else if (meta.session_id_kind === "online") {
      seed_exclude_reason = "online_defer"; // decide in plan; default not primary seed
    } else if (meta.session_id_kind === "offline" && meta.has_access_token && !meta.expired) {
      seed_candidate = true;
    } else {
      seed_exclude_reason = "not_valid_offline";
    }

    // Prefer new namespace copy when both exist
    pairResults.push({
      session_id_hash: hashId(id),
      shop: meta.shop,
      classification,
      kind: meta.session_id_kind,
      seed_candidate,
      seed_exclude_reason,
    });
  }

  // Shop set membership (read-only SMEMBERS)
  const shopSetSummary: Array<{
    namespace: Namespace;
    shop_masked: string;
    member_count: number;
    member_kind_counts: Record<string, number>;
  }> = [];

  for (const key of newShopSets) {
    const shop = key.replace("tti:shopify:shop-sessions:", "");
    const members = (await redis.smembers(key)) as string[];
    const kinds: Record<string, number> = {};
    for (const m of members || []) {
      const k = sessionIdKind(m);
      kinds[k] = (kinds[k] || 0) + 1;
    }
    shopSetSummary.push({
      namespace: "new",
      shop_masked: shop.replace(/[a-z0-9-]+\.myshopify\.com/gi, "<shop>"),
      member_count: members?.length || 0,
      member_kind_counts: kinds,
    });
  }
  for (const key of legacyShopSets) {
    const shop = key.replace("shopify:shop-sessions:", "");
    const members = (await redis.smembers(key)) as string[];
    const kinds: Record<string, number> = {};
    for (const m of members || []) {
      const k = sessionIdKind(m);
      kinds[k] = (kinds[k] || 0) + 1;
    }
    shopSetSummary.push({
      namespace: "legacy",
      shop_masked: "<shop>",
      member_count: members?.length || 0,
      member_kind_counts: kinds,
    });
    void shop;
  }

  const allMetas = Object.values(byId).flatMap((p) =>
    [p.new?.meta, p.legacy?.meta].filter(Boolean) as SessionMeta[],
  );

  const byShop: Record<string, number> = {};
  const byOnline: Record<string, number> = { online: 0, offline: 0, unknown: 0 };
  const byExpired: Record<string, number> = { expired: 0, valid: 0, unknown: 0 };
  // Deduplicate by session id using preferred new meta
  for (const [id, pair] of Object.entries(byId)) {
    const meta = pair.new?.meta || pair.legacy?.meta!;
    byShop[meta.shop || "unknown"] = (byShop[meta.shop || "unknown"] || 0) + 1;
    if (meta.is_online === true) byOnline.online += 1;
    else if (meta.is_online === false) byOnline.offline += 1;
    else byOnline.unknown += 1;
    if (meta.expired === true) byExpired.expired += 1;
    else if (meta.expired === false) byExpired.valid += 1;
    else byExpired.unknown += 1;
    void id;
  }

  const report = {
    type: "session_l40_audit",
    redis_counts: {
      tti_session_keys: newSessionKeys.length,
      legacy_session_keys: legacyOnly.length,
      tti_shop_session_sets: newShopSets.length,
      legacy_shop_session_sets: legacyShopSets.length,
      unique_session_ids: Object.keys(byId).length,
    },
    by_shop: byShop,
    by_online_offline: byOnline,
    by_expiry: byExpired,
    classifications,
    sessions: allMetas.map((m) => {
      const { parse_error, ...rest } = m;
      return parse_error ? { ...rest, parse_error } : rest;
    }),
    pairs: pairResults,
    shop_sets: shopSetSummary,
    authority_candidates: pairResults.filter((p) => p.seed_candidate),
    notes: {
      write_primary: "tti:shopify:session:* + tti:shopify:shop-sessions:*",
      read_fallback: "new then legacy via getJsonPreferNew / smembersPreferNew",
      dual_write: false,
      delete_both_namespaces: true,
      findSessionsByShop_may_srem_orphans: true,
    },
  };

  assertNoSecrets(report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
