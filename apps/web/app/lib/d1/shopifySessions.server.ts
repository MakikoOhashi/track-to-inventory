/**
 * Shopify session repository for D1 (Stage L1).
 * Payload shape matches Redis SessionStorage (toPropertyArray / fromPropertyArray).
 * Not wired into production session path yet (no dual-write / fallback).
 */

import { Session } from "@shopify/shopify-api";
import { D1_MIGRATION_VERSION, nowIso } from "./client.server";
import { classifyD1Error } from "./errors.server";
import type {
  ShopifySessionPayload,
  ShopifySessionRow,
} from "./types.server";

type SessionRaw = Record<string, unknown>;

function mapSessionRow(raw: SessionRaw | null | undefined): ShopifySessionRow | undefined {
  if (!raw) return undefined;
  return {
    id: String(raw.id ?? ""),
    shop: String(raw.shop ?? ""),
    payload_json: String(raw.payload_json ?? ""),
    is_online: Number(raw.is_online ?? 0),
    expires_at: raw.expires_at == null || raw.expires_at === ""
      ? null
      : String(raw.expires_at),
    migration_source: raw.migration_source == null ? null : String(raw.migration_source),
    migration_version: raw.migration_version == null ? null : String(raw.migration_version),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  };
}

/** Same shape as Redis UpstashSessionStorage payload. */
export function serializeSessionPayload(session: Session): ShopifySessionPayload {
  return {
    entries: session.toPropertyArray(true),
    shop: session.shop,
    expiresAt: session.expires?.getTime(),
  };
}

export function deserializeSessionPayload(
  payload: ShopifySessionPayload,
): Session {
  return Session.fromPropertyArray(payload.entries, true);
}

function isExpired(expiresAt: string | null, nowMs: number): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t <= nowMs;
}

export type ShopifySessionRepository = {
  storeSession: (session: Session) => Promise<boolean>;
  loadSession: (id: string) => Promise<Session | undefined>;
  deleteSession: (id: string) => Promise<boolean>;
  findSessionsByShop: (shop: string) => Promise<Session[]>;
};

export function createShopifySessionRepository(
  db: D1Database,
): ShopifySessionRepository {
  async function storeSession(session: Session): Promise<boolean> {
    const payload = serializeSessionPayload(session);
    const ts = nowIso();
    const expiresAt =
      session.isOnline && session.expires
        ? session.expires.toISOString()
        : null;

    try {
      await db
        .prepare(
          `INSERT INTO shopify_sessions (
             id, shop, payload_json, is_online, expires_at,
             migration_source, migration_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'runtime', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             shop = excluded.shop,
             payload_json = excluded.payload_json,
             is_online = excluded.is_online,
             expires_at = excluded.expires_at,
             migration_source = excluded.migration_source,
             migration_version = excluded.migration_version,
             updated_at = excluded.updated_at`,
        )
        .bind(
          session.id,
          session.shop,
          JSON.stringify(payload),
          session.isOnline ? 1 : 0,
          expiresAt,
          D1_MIGRATION_VERSION,
          ts,
          ts,
        )
        .run();
      return true;
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function loadSession(id: string): Promise<Session | undefined> {
    try {
      const raw = await db
        .prepare(`SELECT * FROM shopify_sessions WHERE id = ?`)
        .bind(id)
        .first<SessionRaw>();
      const row = mapSessionRow(raw ?? undefined);
      if (!row) return undefined;

      if (isExpired(row.expires_at, Date.now())) {
        return undefined;
      }

      const payload = JSON.parse(row.payload_json) as ShopifySessionPayload;
      if (!payload?.entries) return undefined;
      return deserializeSessionPayload(payload);
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function deleteSession(id: string): Promise<boolean> {
    try {
      await db
        .prepare(`DELETE FROM shopify_sessions WHERE id = ?`)
        .bind(id)
        .run();
      return true;
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
           ORDER BY
             CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END DESC,
             expires_at DESC`,
        )
        .bind(shop)
        .all<SessionRaw>();

      const now = Date.now();
      const sessions: Session[] = [];
      for (const raw of result.results ?? []) {
        const row = mapSessionRow(raw);
        if (!row) continue;
        if (isExpired(row.expires_at, now)) continue;
        try {
          const payload = JSON.parse(row.payload_json) as ShopifySessionPayload;
          if (!payload?.entries) continue;
          sessions.push(deserializeSessionPayload(payload));
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
    deleteSession,
    findSessionsByShop,
  };
}
