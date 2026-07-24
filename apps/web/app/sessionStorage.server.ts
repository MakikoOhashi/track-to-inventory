import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { Redis } from "@upstash/redis";
import { smembersPreferNew } from "~/lib/redisCompat.server";
import {
  shopifySessionKey,
  shopifySessionKeyLegacy,
  shopifyShopSessionsKey,
  shopifyShopSessionsKeyLegacy,
} from "~/lib/redisKeys.server";
import {
  scheduleSessionD1Shadow,
  type RedisSessionNamespace,
} from "~/lib/sessionD1Shadow.server";
import {
  mirrorSessionDeleteToD1,
  mirrorSessionStoreToD1,
} from "~/lib/sessionD1DualWrite.server";

type StoredSessionPayload = {
  entries: [string, string | number | boolean][];
  shop: string;
  expiresAt?: number;
};

function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash Redis environment variables are required");
  }

  return new Redis({ url, token });
}

function getOnlineExpiresInSeconds(session: Session) {
  if (!session.isOnline || !session.expires) return undefined;

  const seconds = Math.floor((session.expires.getTime() - Date.now()) / 1000);
  return Math.max(seconds, 1);
}

function sortSessionsByExpiryDesc(a: Session, b: Session) {
  const aTime = a.expires?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bTime = b.expires?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return bTime - aTime;
}

/**
 * Shopify SessionStorage backed by Upstash Redis (authority).
 * Keys: tti:shopify:session:* / tti:shopify:shop-sessions:*
 * Legacy shopify:* is read-fallback; writes go to tti: only.
 * Stage L4.2: loadSession may shadow-compare D1 (never returns D1 / never rescues).
 * Stage L4.3: store/delete may mirror to D1 after Redis success (dual_write mode).
 */
class UpstashSessionStorage implements SessionStorage {
  private redis = getRedisClient();

  async storeSession(session: Session): Promise<boolean> {
    const payload: StoredSessionPayload = {
      entries: session.toPropertyArray(true),
      shop: session.shop,
      expiresAt: session.expires?.getTime(),
    };

    const sessionKey = shopifySessionKey(session.id);
    const shopSetKey = shopifyShopSessionsKey(session.shop);
    const onlineTtl = getOnlineExpiresInSeconds(session);

    if (onlineTtl) {
      await this.redis.setex(sessionKey, onlineTtl, payload);
    } else {
      await this.redis.set(sessionKey, payload);
    }

    await this.redis.sadd(shopSetKey, session.id);

    // D1 mirror only after Redis success; failures must not change Redis result.
    try {
      await mirrorSessionStoreToD1(session);
    } catch {
      // ignore — Redis remains authority
    }

    return true;
  }

  /**
   * Redis-only load (no D1 shadow). Used by findSessionsByShop —
   * find path is out of L4.2 shadow scope (and may SREM orphans).
   */
  private async loadSessionFromRedis(id: string): Promise<{
    session: Session | undefined;
    namespace: RedisSessionNamespace;
  }> {
    const newKey = shopifySessionKey(id);
    const legacyKey = shopifySessionKeyLegacy(id);

    const neu = (await this.redis.get(newKey)) as StoredSessionPayload | null;
    if (neu?.entries) {
      return {
        session: Session.fromPropertyArray(neu.entries, true),
        namespace: "tti",
      };
    }

    const legacy = (await this.redis.get(legacyKey)) as StoredSessionPayload | null;
    if (legacy?.entries) {
      return {
        session: Session.fromPropertyArray(legacy.entries, true),
        namespace: "legacy",
      };
    }

    return { session: undefined, namespace: "miss" };
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const { session, namespace } = await this.loadSessionFromRedis(id);

    // Shadow never alters return value; exceptions must not escape.
    try {
      scheduleSessionD1Shadow({
        sessionId: id,
        redisSession: session,
        primaryNamespace: namespace,
      });
    } catch {
      // ignore scheduler failures
    }

    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    const newKey = shopifySessionKey(id);
    const legacyKey = shopifySessionKeyLegacy(id);
    const neu = (await this.redis.get(newKey)) as StoredSessionPayload | null;
    const legacy =
      neu == null
        ? ((await this.redis.get(legacyKey)) as StoredSessionPayload | null)
        : null;
    const shop = neu?.shop || legacy?.shop;

    await this.redis.del(newKey);
    await this.redis.del(legacyKey);

    if (shop) {
      await this.redis.srem(shopifyShopSessionsKey(shop), id);
      await this.redis.srem(shopifyShopSessionsKeyLegacy(shop), id);
    }

    // D1 soft-delete only after Redis success; never alter logout result.
    try {
      await mirrorSessionDeleteToD1({ sessionId: id, shop });
    } catch {
      // ignore — Redis remains authority
    }

    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const ids = await smembersPreferNew(
      this.redis,
      shopifyShopSessionsKey(shop),
      shopifyShopSessionsKeyLegacy(shop),
    );
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }

    const sessions = await Promise.all(
      ids.map(async (id) => {
        // No D1 shadow on find path (L4.2 scope)
        const { session } = await this.loadSessionFromRedis(id);
        if (!session) {
          await this.redis.srem(shopifyShopSessionsKey(shop), id);
          await this.redis.srem(shopifyShopSessionsKeyLegacy(shop), id);
        }
        return session;
      }),
    );

    return sessions
      .filter((session): session is Session => Boolean(session))
      .sort(sortSessionsByExpiryDesc)
      .slice(0, 25);
  }
}

const sessionStorage = new UpstashSessionStorage();

export default sessionStorage;
