import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { Redis } from "@upstash/redis";
import { getJsonPreferNew, smembersPreferNew } from "~/lib/redisCompat.server";
import {
  shopifySessionKey,
  shopifySessionKeyLegacy,
  shopifyShopSessionsKey,
  shopifyShopSessionsKeyLegacy,
} from "~/lib/redisKeys.server";

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
 * Shopify SessionStorage backed only by Upstash Redis.
 * Keys: tti:shopify:session:* / tti:shopify:shop-sessions:*
 * Legacy shopify:* is read-fallback; writes go to tti: only.
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
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const payload = await getJsonPreferNew<StoredSessionPayload>(
      this.redis,
      shopifySessionKey(id),
      shopifySessionKeyLegacy(id),
    );
    if (!payload?.entries) return undefined;

    return Session.fromPropertyArray(payload.entries, true);
  }

  async deleteSession(id: string): Promise<boolean> {
    const existing = await getJsonPreferNew<StoredSessionPayload>(
      this.redis,
      shopifySessionKey(id),
      shopifySessionKeyLegacy(id),
    );

    await this.redis.del(shopifySessionKey(id));
    await this.redis.del(shopifySessionKeyLegacy(id));

    if (existing?.shop) {
      await this.redis.srem(shopifyShopSessionsKey(existing.shop), id);
      await this.redis.srem(shopifyShopSessionsKeyLegacy(existing.shop), id);
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
        const session = await this.loadSession(id);
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
