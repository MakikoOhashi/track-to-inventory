/**
 * Notion connection metadata repositories (Stage L8.1).
 * Not wired into notionConnection.server.ts (Redis remains runtime authority).
 *
 * Atomicity:
 * - OAuth consume: single DELETE … WHERE state AND expires_at > now RETURNING
 * - Provision lock: INSERT OR IGNORE, then UPDATE … WHERE expires_at <= now (CAS reclaim)
 * - Lock release: DELETE … WHERE shop_id AND owner_token
 */

import type { EncryptedBlob } from "~/lib/tokenEncryption.server";
import { normalizeShopDomain } from "~/utils/shopDomain";
import { D1_MIGRATION_VERSION, nowIso } from "./client.server";

type RawRow = Record<string, unknown>;

export type NotionConnectionStatus =
  | "connected"
  | "provisioned"
  | "error"
  | "revoked";

export type NotionConnectionRecord = {
  shop_id: string;
  workspace_id: string | null;
  workspace_name: string | null;
  bot_id: string | null;
  access_token: EncryptedBlob;
  parent_page_id: string | null;
  shipments_database_id: string | null;
  shipments_data_source_id: string | null;
  schema_version: number | null;
  status: NotionConnectionStatus;
  last_error: string | null;
  connected_at: string;
  created_at: string;
  updated_at: string;
};

export type NotionOAuthStateRecord = {
  state: string;
  shop_id: string;
  return_path: string | null;
  expires_at: string;
  created_at: string;
};

export type NotionProvisionLockRecord = {
  shop_id: string;
  owner_token: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function emptyToNull(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

function parseEncryptedBlob(raw: unknown): EncryptedBlob | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as EncryptedBlob;
    if (
      parsed?.v === 1 &&
      typeof parsed.iv === "string" &&
      typeof parsed.ciphertext === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function serializeEncryptedBlob(blob: EncryptedBlob): string {
  return JSON.stringify(blob);
}

function mapConnectionRow(raw: RawRow | null | undefined): NotionConnectionRecord | undefined {
  if (!raw) return undefined;
  const token = parseEncryptedBlob(raw.access_token_enc);
  if (!token) return undefined;
  const shop = normalizeShopDomain(String(raw.shop_id ?? ""));
  if (!shop) return undefined;
  return {
    shop_id: shop,
    workspace_id: emptyToNull(raw.workspace_id),
    workspace_name: emptyToNull(raw.workspace_name),
    bot_id: emptyToNull(raw.bot_id),
    access_token: token,
    parent_page_id: emptyToNull(raw.parent_page_id),
    shipments_database_id: emptyToNull(raw.shipments_database_id),
    shipments_data_source_id: emptyToNull(raw.shipments_data_source_id),
    schema_version:
      raw.schema_version == null || raw.schema_version === ""
        ? null
        : Number(raw.schema_version),
    status: String(raw.status ?? "connected") as NotionConnectionStatus,
    last_error: emptyToNull(raw.last_error),
    connected_at: String(raw.connected_at ?? raw.created_at ?? ""),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  };
}

function defaultOAuthTtlSeconds(): number {
  return 600;
}

function defaultProvisionLockTtlSeconds(): number {
  return 90;
}

function expiresAtFromNow(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

export type NotionConnectionRepository = {
  get: (shopId: string) => Promise<NotionConnectionRecord | undefined>;
  upsert: (record: NotionConnectionRecord) => Promise<void>;
  delete: (shopId: string) => Promise<boolean>;
};

export type NotionOAuthStateRepository = {
  save: (params: {
    state: string;
    shopId: string;
    returnPath?: string | null;
    ttlSeconds?: number;
  }) => Promise<void>;
  consume: (state: string) => Promise<NotionOAuthStateRecord | undefined>;
};

export type ProvisionLockAcquireResult =
  | { ok: true; ownerToken: string; expiresAt: string }
  | { ok: false; reason: "INVALID_SHOP" | "LOCK_BUSY" };

export type NotionProvisionLockRepository = {
  acquire: (
    shopId: string,
    options?: { ttlSeconds?: number },
  ) => Promise<ProvisionLockAcquireResult>;
  release: (shopId: string, ownerToken: string) => Promise<boolean>;
  get: (shopId: string) => Promise<NotionProvisionLockRecord | undefined>;
};

export function createNotionConnectionRepository(
  db: D1Database,
): NotionConnectionRepository {
  return {
    async get(shopId) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) return undefined;
      const raw = await db
        .prepare(
          `SELECT shop_id, workspace_id, workspace_name, bot_id, access_token_enc,
                  parent_page_id, shipments_database_id, shipments_data_source_id,
                  schema_version, status, last_error, connected_at,
                  created_at, updated_at
           FROM notion_connections
           WHERE shop_id = ?`,
        )
        .bind(shop)
        .first<RawRow>();
      return mapConnectionRow(raw ?? undefined);
    },

    async upsert(record) {
      const shop = normalizeShopDomain(record.shop_id);
      if (!shop) throw new Error("Invalid shop_id");
      const now = nowIso();
      const enc = serializeEncryptedBlob(record.access_token);
      const connectedAt = record.connected_at || now;

      await db
        .prepare(
          `INSERT INTO notion_connections (
             shop_id, workspace_id, workspace_name, bot_id, access_token_enc,
             parent_page_id, shipments_database_id, shipments_data_source_id,
             schema_version, status, last_error, connected_at,
             migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'runtime', ?, ?, ?)
           ON CONFLICT(shop_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             workspace_name = excluded.workspace_name,
             bot_id = excluded.bot_id,
             access_token_enc = excluded.access_token_enc,
             parent_page_id = excluded.parent_page_id,
             shipments_database_id = excluded.shipments_database_id,
             shipments_data_source_id = excluded.shipments_data_source_id,
             schema_version = excluded.schema_version,
             status = excluded.status,
             last_error = excluded.last_error,
             connected_at = COALESCE(notion_connections.connected_at, excluded.connected_at),
             updated_at = excluded.updated_at,
             migration_source = excluded.migration_source,
             migration_version = excluded.migration_version`,
        )
        .bind(
          shop,
          record.workspace_id,
          record.workspace_name,
          record.bot_id,
          enc,
          record.parent_page_id,
          record.shipments_database_id,
          record.shipments_data_source_id,
          record.schema_version,
          record.status,
          record.last_error,
          connectedAt,
          D1_MIGRATION_VERSION,
          connectedAt,
          now,
        )
        .run();
    },

    async delete(shopId) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) return false;
      const result = await db
        .prepare(`DELETE FROM notion_connections WHERE shop_id = ?`)
        .bind(shop)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
  };
}

export function createNotionOAuthStateRepository(
  db: D1Database,
): NotionOAuthStateRepository {
  return {
    async save(params) {
      const shop = normalizeShopDomain(params.shopId);
      if (!shop) throw new Error("Invalid shop_id");
      if (!params.state.trim()) throw new Error("Invalid state");
      const now = nowIso();
      const ttl = params.ttlSeconds ?? defaultOAuthTtlSeconds();
      const expiresAt = expiresAtFromNow(ttl);
      const returnPath =
        typeof params.returnPath === "string" && params.returnPath.trim()
          ? params.returnPath.trim()
          : null;

      await db
        .prepare(
          `INSERT INTO notion_oauth_states (
             state, shop_id, return_path, expires_at,
             migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'runtime', ?, ?, ?)
           ON CONFLICT(state) DO UPDATE SET
             shop_id = excluded.shop_id,
             return_path = excluded.return_path,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at,
             migration_source = excluded.migration_source,
             migration_version = excluded.migration_version`,
        )
        .bind(
          params.state,
          shop,
          returnPath,
          expiresAt,
          D1_MIGRATION_VERSION,
          now,
          now,
        )
        .run();
    },

    async consume(state) {
      if (!state.trim()) return undefined;
      const now = nowIso();
      const raw = await db
        .prepare(
          `DELETE FROM notion_oauth_states
           WHERE state = ? AND expires_at > ?
           RETURNING state, shop_id, return_path, expires_at, created_at`,
        )
        .bind(state, now)
        .first<RawRow>();

      if (!raw) return undefined;
      const shop = normalizeShopDomain(String(raw.shop_id ?? ""));
      if (!shop) return undefined;
      return {
        state: String(raw.state ?? state),
        shop_id: shop,
        return_path: emptyToNull(raw.return_path),
        expires_at: String(raw.expires_at ?? ""),
        created_at: String(raw.created_at ?? ""),
      };
    },
  };
}

export function createNotionProvisionLockRepository(
  db: D1Database,
): NotionProvisionLockRepository {
  return {
    async acquire(shopId, options) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) return { ok: false, reason: "INVALID_SHOP" };

      const now = nowIso();
      const ttl = options?.ttlSeconds ?? defaultProvisionLockTtlSeconds();
      const expiresAt = expiresAtFromNow(ttl);
      const ownerToken = crypto.randomUUID();

      const insert = await db
        .prepare(
          `INSERT OR IGNORE INTO notion_provision_locks (
             shop_id, owner_token, expires_at,
             migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, 'runtime', ?, ?, ?)`,
        )
        .bind(shop, ownerToken, expiresAt, D1_MIGRATION_VERSION, now, now)
        .run();

      if ((insert.meta.changes ?? 0) > 0) {
        return { ok: true, ownerToken, expiresAt };
      }

      const reclaim = await db
        .prepare(
          `UPDATE notion_provision_locks
           SET owner_token = ?, expires_at = ?, updated_at = ?,
               migration_source = 'runtime', migration_version = ?
           WHERE shop_id = ? AND expires_at <= ?`,
        )
        .bind(ownerToken, expiresAt, now, D1_MIGRATION_VERSION, shop, now)
        .run();

      if ((reclaim.meta.changes ?? 0) > 0) {
        return { ok: true, ownerToken, expiresAt };
      }

      return { ok: false, reason: "LOCK_BUSY" };
    },

    async release(shopId, ownerToken) {
      const shop = normalizeShopDomain(shopId);
      if (!shop || !ownerToken.trim()) return false;
      const result = await db
        .prepare(
          `DELETE FROM notion_provision_locks
           WHERE shop_id = ? AND owner_token = ?`,
        )
        .bind(shop, ownerToken)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async get(shopId) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) return undefined;
      const raw = await db
        .prepare(
          `SELECT shop_id, owner_token, expires_at, created_at, updated_at
           FROM notion_provision_locks
           WHERE shop_id = ?`,
        )
        .bind(shop)
        .first<RawRow>();
      if (!raw) return undefined;
      return {
        shop_id: String(raw.shop_id ?? shop),
        owner_token: String(raw.owner_token ?? ""),
        expires_at: String(raw.expires_at ?? ""),
        created_at: String(raw.created_at ?? ""),
        updated_at: String(raw.updated_at ?? ""),
      };
    },
  };
}
