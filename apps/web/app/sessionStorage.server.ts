import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { Redis } from "@upstash/redis";
import prisma from "./db.server";

type StoredSessionPayload = {
  entries: [string, string | number | boolean][];
  shop: string;
  expiresAt?: number;
};

const SESSION_KEY_PREFIX = "shopify:session";
const SHOP_SET_KEY_PREFIX = "shopify:shop-sessions";

function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash Redis environment variables are required");
  }

  return new Redis({ url, token });
}

function getSessionKey(id: string) {
  return `${SESSION_KEY_PREFIX}:${id}`;
}

function getShopSetKey(shop: string) {
  return `${SHOP_SET_KEY_PREFIX}:${shop}`;
}

function getExpiresInSeconds(session: Session) {
  if (!session.expires) return undefined;

  const seconds = Math.floor((session.expires.getTime() - Date.now()) / 1000);
  return Math.max(seconds, 1);
}

function sortSessionsByExpiryDesc(a: Session, b: Session) {
  const aTime = a.expires?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bTime = b.expires?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return bTime - aTime;
}

class UpstashSessionStorage implements SessionStorage {
  private redis = getRedisClient();

  async storeSession(session: Session): Promise<boolean> {
    const payload: StoredSessionPayload = {
      entries: session.toPropertyArray(true),
      shop: session.shop,
      expiresAt: session.expires?.getTime(),
    };

    const ttl = getExpiresInSeconds(session);
    const sessionKey = getSessionKey(session.id);
    const shopSetKey = getShopSetKey(session.shop);

    if (ttl) {
      await this.redis.setex(sessionKey, ttl, payload);
      await this.redis.expire(shopSetKey, ttl);
    } else {
      await this.redis.set(sessionKey, payload);
    }

    await this.redis.sadd(shopSetKey, session.id);
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const payload = await this.redis.get<StoredSessionPayload>(getSessionKey(id));
    if (!payload?.entries) return undefined;

    return Session.fromPropertyArray(payload.entries, true);
  }

  async deleteSession(id: string): Promise<boolean> {
    const existing = await this.redis.get<StoredSessionPayload>(getSessionKey(id));

    await this.redis.del(getSessionKey(id));

    if (existing?.shop) {
      await this.redis.srem(getShopSetKey(existing.shop), id);
    }

    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const ids = (await this.redis.smembers<string[]>(getShopSetKey(shop))) ?? [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }

    const sessions = await Promise.all(
      ids.map(async (id) => {
        const session = await this.loadSession(id);
        if (!session) {
          await this.redis.srem(getShopSetKey(shop), id);
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

function getSessionStorageDriver() {
  return (process.env.SHOPIFY_SESSION_STORAGE ?? "prisma").toLowerCase();
}

function createSessionStorage() {
  if (getSessionStorageDriver() === "upstash") {
    return new UpstashSessionStorage();
  }

  return new PrismaSessionStorage(prisma);
}

const sessionStorage = createSessionStorage();

export default sessionStorage;
