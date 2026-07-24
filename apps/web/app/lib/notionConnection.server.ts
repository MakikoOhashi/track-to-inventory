import { Redis } from "@upstash/redis";
import {
  decryptUtf8,
  encryptUtf8,
  type EncryptedBlob,
} from "~/lib/tokenEncryption.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * Notion connection storage — separate namespace from Shopify sessions.
 * No TTL on connection records (must not share online-session TTLs).
 *
 * Keys:
 *   notion:connection:{shopDomain}
 *   notion:oauth-state:{state}   (short TTL)
 *   notion:provision-lock:{shopDomain}  (short NX lock)
 */

export const NOTION_CONNECTION_SCHEMA_VERSION = 1;
export const TTI_SHIPMENTS_DB_TITLE = "TrackToInventory Shipments";

export type NotionConnectionStatus =
  | "connected"
  | "provisioned"
  | "error"
  | "revoked";

export type NotionConnectionRecord = {
  v: typeof NOTION_CONNECTION_SCHEMA_VERSION;
  shop_id: string;
  workspace_id: string | null;
  workspace_name: string | null;
  bot_id: string | null;
  /** Encrypted Notion access token */
  access_token: EncryptedBlob;
  parent_page_id: string | null;
  shipments_database_id: string | null;
  shipments_data_source_id: string | null;
  schema_version: number | null;
  status: NotionConnectionStatus;
  last_error: string | null;
  connected_at: string;
  updated_at: string;
};

export type NotionOAuthState = {
  shop: string;
  created_at: string;
  return_path?: string;
};

function redis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Upstash Redis is not configured");
  }
  return new Redis({ url, token });
}

function connectionKey(shop: string): string {
  return `notion:connection:${shop}`;
}

function oauthStateKey(state: string): string {
  return `notion:oauth-state:${state}`;
}

function provisionLockKey(shop: string): string {
  return `notion:provision-lock:${shop}`;
}

export async function saveNotionOAuthState(
  state: string,
  payload: NotionOAuthState,
): Promise<void> {
  // 10 minutes — must not be used for long-lived connection storage
  await redis().set(oauthStateKey(state), payload, { ex: 600 });
}

export async function consumeNotionOAuthState(
  state: string,
): Promise<NotionOAuthState | null> {
  const key = oauthStateKey(state);
  const r = redis();
  const value = (await r.get(key)) as NotionOAuthState | null;
  await r.del(key);
  if (!value || typeof value.shop !== "string") return null;
  const shop = normalizeShopDomain(value.shop);
  if (!shop) return null;
  return { ...value, shop };
}

export async function getNotionConnection(
  shopId: string,
): Promise<NotionConnectionRecord | null> {
  const shop = normalizeShopDomain(shopId);
  if (!shop) return null;
  const value = (await redis().get(connectionKey(shop))) as NotionConnectionRecord | null;
  if (!value || value.shop_id !== shop) return null;
  return value;
}

export async function saveNotionConnection(
  record: NotionConnectionRecord,
): Promise<void> {
  const shop = normalizeShopDomain(record.shop_id);
  if (!shop) throw new Error("Invalid shop_id");
  // Explicitly no TTL — durable connection metadata
  await redis().set(connectionKey(shop), { ...record, shop_id: shop });
}

export async function deleteNotionConnection(shopId: string): Promise<void> {
  const shop = normalizeShopDomain(shopId);
  if (!shop) return;
  await redis().del(connectionKey(shop));
}

export async function getNotionAccessToken(shopId: string): Promise<string | null> {
  const conn = await getNotionConnection(shopId);
  if (!conn) return null;
  try {
    return await decryptUtf8(conn.access_token);
  } catch {
    return null;
  }
}

export async function upsertNotionConnectionFromOAuth(params: {
  shop: string;
  accessToken: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  botId?: string | null;
}): Promise<NotionConnectionRecord> {
  const shop = normalizeShopDomain(params.shop);
  if (!shop) throw new Error("Invalid shop");

  const encrypted = await encryptUtf8(params.accessToken);
  const existing = await getNotionConnection(shop);
  const now = new Date().toISOString();

  const record: NotionConnectionRecord = {
    v: NOTION_CONNECTION_SCHEMA_VERSION,
    shop_id: shop,
    workspace_id: params.workspaceId ?? existing?.workspace_id ?? null,
    workspace_name: params.workspaceName ?? existing?.workspace_name ?? null,
    bot_id: params.botId ?? existing?.bot_id ?? null,
    access_token: encrypted,
    parent_page_id: existing?.parent_page_id ?? null,
    shipments_database_id: existing?.shipments_database_id ?? null,
    shipments_data_source_id: existing?.shipments_data_source_id ?? null,
    schema_version: existing?.schema_version ?? null,
    status: existing?.shipments_database_id ? "provisioned" : "connected",
    last_error: null,
    connected_at: existing?.connected_at ?? now,
    updated_at: now,
  };

  await saveNotionConnection(record);
  return record;
}

/** Public-safe view (never includes token ciphertext). */
export function toPublicNotionConnection(conn: NotionConnectionRecord | null) {
  if (!conn) {
    return { connected: false as const };
  }
  return {
    connected: true as const,
    shop_id: conn.shop_id,
    workspace_id: conn.workspace_id,
    workspace_name: conn.workspace_name,
    bot_id: conn.bot_id,
    parent_page_id: conn.parent_page_id,
    shipments_database_id: conn.shipments_database_id,
    shipments_data_source_id: conn.shipments_data_source_id,
    schema_version: conn.schema_version,
    status: conn.status,
    last_error: conn.last_error,
    connected_at: conn.connected_at,
    updated_at: conn.updated_at,
  };
}

export async function acquireProvisionLock(shopId: string): Promise<boolean> {
  const shop = normalizeShopDomain(shopId);
  if (!shop) return false;
  const result = await redis().set(provisionLockKey(shop), "1", { nx: true, ex: 90 });
  return result === "OK";
}

export async function releaseProvisionLock(shopId: string): Promise<void> {
  const shop = normalizeShopDomain(shopId);
  if (!shop) return;
  await redis().del(provisionLockKey(shop));
}
