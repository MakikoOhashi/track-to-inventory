import type { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import {
  deleteSessionD1Only,
  findSessionsByShopD1Only,
  loadSessionD1Only,
  storeSessionD1Only,
} from "~/lib/sessionD1Only.server";

/**
 * Shopify SessionStorage (Stage L6.0).
 *
 * D1 is the fixed session authority. The Redis session compatibility path
 * (mode flag / shadow / dual_write / d1_primary + Redis adapter) was
 * removed in L6.0. This file no longer touches Redis in any way.
 *
 * Note: inventory sync ledger and Notion still use Redis elsewhere; those are
 * unaffected. Old Redis session keys are not deleted yet (separate stage).
 */
class ShopifySessionStorage implements SessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    return storeSessionD1Only({ session });
  }

  async loadSession(id: string): Promise<Session | undefined> {
    return loadSessionD1Only({ sessionId: id });
  }

  async deleteSession(id: string): Promise<boolean> {
    return deleteSessionD1Only({ sessionId: id });
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return findSessionsByShopD1Only({ shop });
  }
}

const sessionStorage = new ShopifySessionStorage();

export default sessionStorage;
