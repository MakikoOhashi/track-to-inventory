/**
 * Redis Shopify session fallback adapter (Stage L4.5).
 *
 * Isolates Upstash SDK, session key namespace, TTL, and serialization so the
 * Redis session surface can be deleted later without hunting call sites.
 *
 * Used by rollback modes (off / shadow / dual_write / d1_primary).
 * Not used when SESSION_D1_MODE=d1_only.
 *
 * DELETE TARGET (session Redis): this file + shopify* keys in redisKeys +
 * sessionStorage Redis branches. Shared Upstash (ledger/notion) is separate.
 */

import { Session } from "@shopify/shopify-api";
import { Redis } from "@upstash/redis";
import { smembersPreferNew } from "~/lib/redisCompat.server";
import {
  shopifySessionKey,
  shopifySessionKeyLegacy,
  shopifyShopSessionsKey,
  shopifyShopSessionsKeyLegacy,
} from "~/lib/redisKeys.server";
import type { RedisSessionNamespace } from "~/lib/sessionD1Shadow.server";

export type RedisStoredSessionPayload = {
  entries: [string, string | number | boolean][];
  shop: string;
  expiresAt?: number;
};

export class RedisSessionConfigError extends Error {
  constructor(message = "Upstash Redis environment variables are required") {
    super(message);
    this.name = "RedisSessionConfigError";
  }
}

function getOnlineExpiresInSeconds(session: Session): number | undefined {
  if (!session.isOnline || !session.expires) return undefined;
  const seconds = Math.floor((session.expires.getTime() - Date.now()) / 1000);
  return Math.max(seconds, 1);
}

function sortSessionsByExpiryDesc(a: Session, b: Session) {
  const aTime = a.expires?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bTime = b.expires?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return bTime - aTime;
}

export type RedisSessionFallbackAdapter = {
  /** True when UPSTASH_REDIS_REST_URL + TOKEN are present (no network call). */
  isConfigured: () => boolean;
  load: (id: string) => Promise<{
    session: Session | undefined;
    namespace: RedisSessionNamespace;
  }>;
  store: (session: Session) => Promise<boolean>;
  /** Deletes session keys; returns shop when known (for D1 mirror). */
  delete: (id: string) => Promise<{ ok: true; shop?: string }>;
  findByShop: (shop: string) => Promise<Session[]>;
};

function requireRedisClient(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new RedisSessionConfigError();
  }
  return new Redis({ url, token });
}

export function isRedisSessionConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * Create the Redis session adapter. Client is created lazily on first op
 * so importing this module does not require Redis env (needed for d1_only).
 */
export function createRedisSessionFallbackAdapter(): RedisSessionFallbackAdapter {
  let client: Redis | undefined;

  const redis = (): Redis => {
    if (!client) client = requireRedisClient();
    return client;
  };

  return {
    isConfigured: () => isRedisSessionConfigured(),

    async load(id: string) {
      const r = redis();
      const newKey = shopifySessionKey(id);
      const legacyKey = shopifySessionKeyLegacy(id);

      const neu = (await r.get(newKey)) as RedisStoredSessionPayload | null;
      if (neu?.entries) {
        return {
          session: Session.fromPropertyArray(neu.entries, true),
          namespace: "tti" as const,
        };
      }

      const legacy = (await r.get(legacyKey)) as RedisStoredSessionPayload | null;
      if (legacy?.entries) {
        return {
          session: Session.fromPropertyArray(legacy.entries, true),
          namespace: "legacy" as const,
        };
      }

      return { session: undefined, namespace: "miss" as const };
    },

    async store(session: Session) {
      const r = redis();
      const payload: RedisStoredSessionPayload = {
        entries: session.toPropertyArray(true),
        shop: session.shop,
        expiresAt: session.expires?.getTime(),
      };
      const sessionKey = shopifySessionKey(session.id);
      const shopSetKey = shopifyShopSessionsKey(session.shop);
      const onlineTtl = getOnlineExpiresInSeconds(session);

      if (onlineTtl) {
        await r.setex(sessionKey, onlineTtl, payload);
      } else {
        await r.set(sessionKey, payload);
      }
      await r.sadd(shopSetKey, session.id);
      return true;
    },

    async delete(id: string) {
      const r = redis();
      const newKey = shopifySessionKey(id);
      const legacyKey = shopifySessionKeyLegacy(id);
      const neu = (await r.get(newKey)) as RedisStoredSessionPayload | null;
      const legacy =
        neu == null
          ? ((await r.get(legacyKey)) as RedisStoredSessionPayload | null)
          : null;
      const shop = neu?.shop || legacy?.shop;

      await r.del(newKey);
      await r.del(legacyKey);

      if (shop) {
        await r.srem(shopifyShopSessionsKey(shop), id);
        await r.srem(shopifyShopSessionsKeyLegacy(shop), id);
      }
      return { ok: true as const, shop: shop || undefined };
    },

    async findByShop(shop: string) {
      const r = redis();
      const ids = await smembersPreferNew(
        r,
        shopifyShopSessionsKey(shop),
        shopifyShopSessionsKeyLegacy(shop),
      );
      if (!Array.isArray(ids) || ids.length === 0) return [];

      const sessions = await Promise.all(
        ids.map(async (id) => {
          const newKey = shopifySessionKey(id);
          const legacyKey = shopifySessionKeyLegacy(id);
          const neu = (await r.get(newKey)) as RedisStoredSessionPayload | null;
          if (neu?.entries) {
            return Session.fromPropertyArray(neu.entries, true);
          }
          const legacy = (await r.get(
            legacyKey,
          )) as RedisStoredSessionPayload | null;
          if (legacy?.entries) {
            return Session.fromPropertyArray(legacy.entries, true);
          }
          await r.srem(shopifyShopSessionsKey(shop), id);
          await r.srem(shopifyShopSessionsKeyLegacy(shop), id);
          return undefined;
        }),
      );

      return sessions
        .filter((s): s is Session => Boolean(s))
        .sort(sortSessionsByExpiryDesc)
        .slice(0, 25);
    },
  };
}
