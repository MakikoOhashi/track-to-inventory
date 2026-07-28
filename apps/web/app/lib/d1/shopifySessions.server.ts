/**
 * Shopify session repository for D1 (Stage L1 / L4.3).
 * Payload shape matches Redis SessionStorage (toPropertyArray / fromPropertyArray).
 *
 * L4.3 dual-write:
 * - store uses idempotent upsert gated by updated_at (stale writers no-op)
 * - delete soft-deletes (tombstone) so a delayed store cannot resurrect the row
 */

import { Session } from "@shopify/shopify-api";
import {
  decryptSessionSecrets,
  encryptSessionSecrets,
  entriesWithSessionSecrets,
  sessionTokenFingerprint,
  withoutSessionSecrets,
} from "~/lib/shopifySessionSecrets.server";
import { D1_MIGRATION_VERSION, nowIso } from "./client.server";
import { classifyD1Error } from "./errors.server";
import type { ShopifySessionPayload, ShopifySessionRow } from "./types.server";

type SessionRaw = Record<string, unknown>;

const DELETED_PAYLOAD_JSON = '{"deleted":true,"entries":[]}';
export const SESSION_MIGRATION_SOURCE_DELETED = "deleted";

function mapSessionRow(
  raw: SessionRaw | null | undefined,
): ShopifySessionRow | undefined {
  if (!raw) return undefined;
  return {
    id: String(raw.id ?? ""),
    shop: String(raw.shop ?? ""),
    payload_json: String(raw.payload_json ?? ""),
    token_ciphertext:
      raw.token_ciphertext == null || raw.token_ciphertext === ""
        ? null
        : String(raw.token_ciphertext),
    token_expires_at:
      raw.token_expires_at == null || raw.token_expires_at === ""
        ? null
        : String(raw.token_expires_at),
    token_fingerprint:
      raw.token_fingerprint == null || raw.token_fingerprint === ""
        ? null
        : String(raw.token_fingerprint),
    token_generation: Number(raw.token_generation ?? 0),
    is_online: Number(raw.is_online ?? 0),
    expires_at:
      raw.expires_at == null || raw.expires_at === ""
        ? null
        : String(raw.expires_at),
    migration_source:
      raw.migration_source == null ? null : String(raw.migration_source),
    migration_version:
      raw.migration_version == null ? null : String(raw.migration_version),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  };
}

export function isDeletedSessionRow(
  row: Pick<ShopifySessionRow, "migration_source" | "payload_json">,
): boolean {
  if (row.migration_source === SESSION_MIGRATION_SOURCE_DELETED) return true;
  try {
    const parsed = JSON.parse(row.payload_json) as { deleted?: boolean };
    return parsed?.deleted === true;
  } catch {
    return false;
  }
}

/** Same shape as Redis UpstashSessionStorage payload. */
export function serializeSessionPayload(
  session: Session,
): ShopifySessionPayload {
  return {
    entries: withoutSessionSecrets(session.toPropertyArray(true)),
    shop: session.shop,
    expiresAt: session.expires?.getTime(),
  };
}

export function deserializeSessionPayload(
  payload: ShopifySessionPayload,
  secrets?: { accessToken: string; refreshToken?: string },
): Session {
  const entries = secrets
    ? entriesWithSessionSecrets(payload.entries, secrets)
    : payload.entries;
  return Session.fromPropertyArray(entries, true);
}

function isExpired(expiresAt: string | null, nowMs: number): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t <= nowMs;
}

export type SessionWriteOptions = {
  /** ISO timestamp; defaults to now. Used for ordering vs concurrent delete/store. */
  updatedAt?: string;
};

export type SessionDeleteOptions = {
  shop?: string;
  updatedAt?: string;
};

/** Detailed D1 session inspection for Stage L4.4a primary reads. */
export type D1SessionInspectResult =
  | {
      status: "live";
      session: Session;
      row: ShopifySessionRow;
    }
  | { status: "missing" }
  | { status: "tombstone"; row: ShopifySessionRow }
  | { status: "expired"; row: ShopifySessionRow }
  | { status: "invalid"; reason: string; row?: ShopifySessionRow };

export type ShopifySessionRepository = {
  storeSession: (
    session: Session,
    options?: SessionWriteOptions,
  ) => Promise<boolean>;
  loadSession: (id: string) => Promise<Session | undefined>;
  /** Distinguishes missing / tombstone / expired / invalid / live. */
  inspectSession: (id: string) => Promise<D1SessionInspectResult>;
  deleteSession: (
    id: string,
    options?: SessionDeleteOptions,
  ) => Promise<boolean>;
  findSessionsByShop: (shop: string) => Promise<Session[]>;
};

/**
 * Live upsert may apply when:
 * - excluded.updated_at is strictly newer, OR
 * - timestamps are equal AND the current row is not a tombstone
 *   (equal + tombstone present → tombstone wins; live must not resurrect)
 *
 * Delete (tombstone) keeps `>=` so equal timestamp always prefers tombstone.
 */
const STORE_UPSERT_WHERE = `excluded.updated_at > shopify_sessions.updated_at
             OR (
               excluded.updated_at = shopify_sessions.updated_at
               AND IFNULL(shopify_sessions.migration_source, '') != '${SESSION_MIGRATION_SOURCE_DELETED}'
             )`;

const DELETE_UPSERT_WHERE = `excluded.updated_at >= shopify_sessions.updated_at`;

/**
 * The Shopify library can refresh the same offline session concurrently.
 * Newer token expiry wins; an identical token tuple is an idempotent retry.
 * A late response with an older expiry, or a different tuple at equal expiry,
 * cannot overwrite the stored refresh-token rotation.
 */
const TOKEN_ROTATION_CAS_WHERE = `(
               shopify_sessions.is_online != 0
               OR excluded.is_online != 0
               OR (
                 shopify_sessions.token_expires_at IS NULL
                 AND excluded.token_expires_at IS NULL
               )
               OR (
                 shopify_sessions.token_expires_at IS NULL
                 AND excluded.token_expires_at IS NOT NULL
               )
               OR excluded.token_expires_at > shopify_sessions.token_expires_at
               OR (
                 excluded.token_expires_at = shopify_sessions.token_expires_at
                 AND excluded.token_fingerprint = shopify_sessions.token_fingerprint
               )
             )`;

export function createShopifySessionRepository(
  db: D1Database,
): ShopifySessionRepository {
  async function storeSession(
    session: Session,
    options?: SessionWriteOptions,
  ): Promise<boolean> {
    const payload = serializeSessionPayload(session);
    const tokenCiphertext = await encryptSessionSecrets(session);
    const tokenFingerprint = sessionTokenFingerprint(session);
    const ts = options?.updatedAt || nowIso();
    const expiresAt =
      session.isOnline && session.expires
        ? session.expires.toISOString()
        : null;
    const tokenExpiresAt = session.expires?.toISOString() ?? null;

    try {
      const result = await db
        .prepare(
          `INSERT INTO shopify_sessions (
             id, shop, payload_json, token_ciphertext, token_expires_at,
             token_fingerprint, token_generation, is_online, expires_at,
             migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'runtime', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             shop = excluded.shop,
             payload_json = excluded.payload_json,
             token_ciphertext = excluded.token_ciphertext,
             token_expires_at = excluded.token_expires_at,
             token_fingerprint = excluded.token_fingerprint,
             token_generation = CASE
               WHEN excluded.token_fingerprint = shopify_sessions.token_fingerprint
                 THEN shopify_sessions.token_generation
               ELSE shopify_sessions.token_generation + 1
             END,
             is_online = excluded.is_online,
             expires_at = excluded.expires_at,
             migration_source = excluded.migration_source,
             migration_version = excluded.migration_version,
             updated_at = excluded.updated_at
           WHERE (${STORE_UPSERT_WHERE})
             AND ${TOKEN_ROTATION_CAS_WHERE}`,
        )
        .bind(
          session.id,
          session.shop,
          JSON.stringify(payload),
          tokenCiphertext,
          tokenExpiresAt,
          tokenFingerprint,
          session.isOnline ? 1 : 0,
          expiresAt,
          D1_MIGRATION_VERSION,
          ts,
          ts,
        )
        .run();
      // meta.changes === 0 means a newer/equal tombstone rejected this store
      return (result.meta?.changes ?? 1) > 0;
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function inspectSession(id: string): Promise<D1SessionInspectResult> {
    try {
      const raw = await db
        .prepare(`SELECT * FROM shopify_sessions WHERE id = ?`)
        .bind(id)
        .first<SessionRaw>();
      const row = mapSessionRow(raw ?? undefined);
      if (!row || !row.id) return { status: "missing" };
      if (isDeletedSessionRow(row)) return { status: "tombstone", row };

      if (isExpired(row.expires_at, Date.now())) {
        return { status: "expired", row };
      }

      let payload: ShopifySessionPayload;
      try {
        payload = JSON.parse(row.payload_json) as ShopifySessionPayload;
      } catch {
        return { status: "invalid", reason: "payload_json_parse", row };
      }
      if (!payload?.entries || !Array.isArray(payload.entries)) {
        return { status: "invalid", reason: "payload_entries_missing", row };
      }

      let session: Session;
      try {
        const secrets = row.token_ciphertext
          ? await decryptSessionSecrets(row.token_ciphertext)
          : undefined;
        session = deserializeSessionPayload(payload, secrets);
      } catch {
        return { status: "invalid", reason: "session_deserialize", row };
      }

      if (!session.id || session.id !== id) {
        return { status: "invalid", reason: "session_id_mismatch", row };
      }
      if (!session.shop || session.shop !== row.shop) {
        return { status: "invalid", reason: "shop_mismatch", row };
      }
      if (typeof session.isOnline !== "boolean") {
        return { status: "invalid", reason: "is_online_type", row };
      }
      if (Boolean(session.isOnline) !== Boolean(row.is_online)) {
        return { status: "invalid", reason: "is_online_mismatch", row };
      }
      if (!session.accessToken) {
        return { status: "invalid", reason: "access_token_missing", row };
      }
      // Known migration versions only (L1 runtime / seed).
      const ver = row.migration_version || "";
      if (ver && ver !== D1_MIGRATION_VERSION && !/^l4\.1/.test(ver)) {
        return {
          status: "invalid",
          reason: "unsupported_migration_version",
          row,
        };
      }

      return { status: "live", session, row };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function loadSession(id: string): Promise<Session | undefined> {
    const inspected = await inspectSession(id);
    return inspected.status === "live" ? inspected.session : undefined;
  }

  /**
   * Soft-delete (tombstone). Keeps the PK so a stale dual-write store with an
   * older updated_at cannot INSERT a resurrected live session.
   */
  async function deleteSession(
    id: string,
    options?: SessionDeleteOptions,
  ): Promise<boolean> {
    const ts = options?.updatedAt || nowIso();
    const shop = options?.shop || "";
    try {
      const result = await db
        .prepare(
          `INSERT INTO shopify_sessions (
             id, shop, payload_json, is_online, expires_at,
             migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             payload_json = excluded.payload_json,
             token_ciphertext = NULL,
             token_expires_at = NULL,
             token_fingerprint = NULL,
             -- Tombstoning invalidates authentication but is not a token
             -- rotation; reinstall should create generation 1.
             token_generation = shopify_sessions.token_generation,
             is_online = 0,
             expires_at = NULL,
             migration_source = excluded.migration_source,
             migration_version = excluded.migration_version,
             updated_at = excluded.updated_at
           WHERE ${DELETE_UPSERT_WHERE}`,
        )
        .bind(
          id,
          shop,
          DELETED_PAYLOAD_JSON,
          SESSION_MIGRATION_SOURCE_DELETED,
          D1_MIGRATION_VERSION,
          ts,
          ts,
        )
        .run();
      return (result.meta?.changes ?? 1) > 0;
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function findSessionsByShop(shop: string): Promise<Session[]> {
    try {
      const result = await db
        .prepare(
          `SELECT * FROM shopify_sessions
           WHERE shop = ?
             AND IFNULL(migration_source, '') != ?
           ORDER BY
             CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END DESC,
             expires_at DESC`,
        )
        .bind(shop, SESSION_MIGRATION_SOURCE_DELETED)
        .all<SessionRaw>();

      const now = Date.now();
      const sessions: Session[] = [];
      for (const raw of result.results ?? []) {
        const row = mapSessionRow(raw);
        if (!row) continue;
        if (isDeletedSessionRow(row)) continue;
        if (isExpired(row.expires_at, now)) continue;
        try {
          const payload = JSON.parse(row.payload_json) as ShopifySessionPayload;
          if (!payload?.entries) continue;
          const secrets = row.token_ciphertext
            ? await decryptSessionSecrets(row.token_ciphertext)
            : undefined;
          const session = deserializeSessionPayload(payload, secrets);
          if (!session.accessToken) continue;
          sessions.push(session);
        } catch {
          // skip corrupt payload
        }
      }
      return sessions.slice(0, 25);
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  return {
    storeSession,
    loadSession,
    inspectSession,
    deleteSession,
    findSessionsByShop,
  };
}
