import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import {
  createRedisSessionFallbackAdapter,
  type RedisSessionFallbackAdapter,
} from "~/lib/redisSessionFallback.server";
import {
  scheduleSessionD1Shadow,
} from "~/lib/sessionD1Shadow.server";
import {
  mirrorSessionDeleteToD1,
  mirrorSessionStoreToD1,
} from "~/lib/sessionD1DualWrite.server";
import {
  isSessionD1OnlyActive,
  isSessionD1PrimaryActive,
} from "~/lib/sessionD1Mode.server";
import { loadSessionD1Primary } from "~/lib/sessionD1Primary.server";
import {
  deleteSessionD1Only,
  findSessionsByShopD1Only,
  loadSessionD1Only,
  storeSessionD1Only,
} from "~/lib/sessionD1Only.server";

/**
 * Shopify SessionStorage (Stage L4.5).
 *
 * Modes:
 * - d1_only: D1 sole authority (no Redis contact; Redis env optional)
 * - d1_primary / dual_write / shadow / off: Redis via RedisSessionFallbackAdapter
 *   (+ D1 shadow / dual-write / primary fallback as before)
 *
 * Redis SDK / session keys live only in redisSessionFallback.server.ts.
 */
class ShopifySessionStorage implements SessionStorage {
  private redisAdapter: RedisSessionFallbackAdapter | null = null;

  private redis(): RedisSessionFallbackAdapter {
    if (!this.redisAdapter) {
      this.redisAdapter = createRedisSessionFallbackAdapter();
    }
    return this.redisAdapter;
  }

  async storeSession(session: Session): Promise<boolean> {
    if (isSessionD1OnlyActive()) {
      return storeSessionD1Only({ session });
    }

    const ok = await this.redis().store(session);
    if (!ok) return false;

    // D1 mirror only after Redis success; failures must not change Redis result.
    try {
      await mirrorSessionStoreToD1(session);
    } catch {
      // ignore — Redis remains authority in non-d1_only modes
    }

    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    if (isSessionD1OnlyActive()) {
      return loadSessionD1Only({ sessionId: id });
    }

    if (isSessionD1PrimaryActive()) {
      const result = await loadSessionD1Primary({
        sessionId: id,
        loadFromRedis: () => this.redis().load(id),
      });
      return result.session;
    }

    const { session, namespace } = await this.redis().load(id);

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
    if (isSessionD1OnlyActive()) {
      return deleteSessionD1Only({ sessionId: id });
    }

    const { shop } = await this.redis().delete(id);

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
    if (isSessionD1OnlyActive()) {
      return findSessionsByShopD1Only({ shop });
    }
    return this.redis().findByShop(shop);
  }
}

const sessionStorage = new ShopifySessionStorage();

export default sessionStorage;
