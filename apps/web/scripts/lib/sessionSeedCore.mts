/**
 * Shared Session→D1 seed helpers (Stage L4.1).
 * No Redis/D1 I/O here — pure validation / fingerprinting for scripts + tests.
 */
import { createHash } from "node:crypto";
import { Session } from "@shopify/shopify-api";
import type { ShopifySessionPayload } from "../../app/lib/d1/types.server.ts";
import {
  deserializeSessionPayload,
  serializeSessionPayload,
} from "../../app/lib/d1/shopifySessions.server.ts";

export const L41_TARGET_SHOP = "luckywifi-0.myshopify.com";
export const L41_TARGET_ID_HASH = "34c1ff3514f08d08";

export type StoredSessionPayload = ShopifySessionPayload;

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export function hashScope(scope: string | undefined): string | null {
  if (!scope) return null;
  return createHash("sha256").update(scope).digest("hex").slice(0, 12);
}

/** Stable fingerprint for change detection — never log raw inputs with secrets. */
export function sessionFingerprint(session: Session, entryKeys: string[]): string {
  return createHash("sha256")
    .update(
      [
        session.id,
        session.shop,
        String(session.isOnline),
        session.scope || "",
        session.expires ? String(session.expires.getTime()) : "",
        session.accessToken ? "token:yes" : "token:no",
        [...entryKeys].sort().join(","),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
}

export function assertNoSecretsInOutput(obj: unknown): void {
  const s = JSON.stringify(obj);
  if (/shpat_|shpss_/.test(s)) {
    throw new Error("secret leakage: token material in output");
  }
  if (/\"state\":\"[^"]{4,}\"/i.test(s)) {
    throw new Error("secret leakage: state value in output");
  }
  if (/payload_json|accessToken\":\"/i.test(s) && /shpat_/.test(s)) {
    throw new Error("secret leakage: payload in output");
  }
}

export type SeedCandidate = {
  session: Session;
  payload: StoredSessionPayload;
  entry_keys: string[];
  id_hash: string;
  fingerprint: string;
  shop: string;
  is_online: boolean;
  has_expires: boolean;
};

export type SelectError =
  | "zero_candidates"
  | "multiple_candidates"
  | "hash_mismatch"
  | "shop_mismatch"
  | "online_session"
  | "expired"
  | "namespace_mismatch"
  | "malformed"
  | "restore_failed";

export function parseRedisPayload(raw: unknown): StoredSessionPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("malformed");
  }
  const p = raw as StoredSessionPayload;
  if (!Array.isArray(p.entries) || typeof p.shop !== "string") {
    throw new Error("malformed");
  }
  return p;
}

export function restoreSession(payload: StoredSessionPayload): Session {
  return deserializeSessionPayload(payload);
}

/**
 * Select exactly one L4.1 seed candidate from scanned new-namespace sessions.
 * `legacyById` used only for identical check (no duplicate insert of legacy).
 */
export function selectL41Candidate(params: {
  newSessions: Array<{ id: string; payload: unknown }>;
  legacyById: Map<string, unknown>;
  targetShop?: string;
  targetIdHash?: string;
}): { ok: true; candidate: SeedCandidate } | { ok: false; error: SelectError } {
  const targetShop = params.targetShop ?? L41_TARGET_SHOP;
  const targetHash = params.targetIdHash ?? L41_TARGET_ID_HASH;

  const restored: SeedCandidate[] = [];

  for (const row of params.newSessions) {
    let payload: StoredSessionPayload;
    try {
      payload = parseRedisPayload(row.payload);
    } catch {
      return { ok: false, error: "malformed" };
    }

    let session: Session;
    try {
      session = restoreSession(payload);
    } catch {
      return { ok: false, error: "restore_failed" };
    }

    if (session.id !== row.id) {
      return { ok: false, error: "malformed" };
    }

    const idHash = hashSessionId(session.id);
    if (idHash !== targetHash) continue;
    if (session.shop !== targetShop) {
      return { ok: false, error: "shop_mismatch" };
    }
    if (session.isOnline) {
      return { ok: false, error: "online_session" };
    }
    if (session.expires && session.expires.getTime() <= Date.now()) {
      return { ok: false, error: "expired" };
    }

    const legacyRaw = params.legacyById.get(row.id);
    if (legacyRaw != null) {
      try {
        const legacyPayload = parseRedisPayload(legacyRaw);
        const legacySession = restoreSession(legacyPayload);
        const keysNew = payload.entries.map(([k]) => String(k));
        const keysOld = legacyPayload.entries.map(([k]) => String(k));
        const fpNew = sessionFingerprint(session, keysNew);
        const fpOld = sessionFingerprint(legacySession, keysOld);
        if (fpNew !== fpOld) {
          return { ok: false, error: "namespace_mismatch" };
        }
      } catch {
        return { ok: false, error: "namespace_mismatch" };
      }
    }

    restored.push({
      session,
      payload,
      entry_keys: payload.entries.map(([k]) => String(k)).sort(),
      id_hash: idHash,
      fingerprint: sessionFingerprint(
        session,
        payload.entries.map(([k]) => String(k)),
      ),
      shop: session.shop,
      is_online: Boolean(session.isOnline),
      has_expires: Boolean(session.expires),
    });
  }

  if (restored.length === 0) return { ok: false, error: "zero_candidates" };
  if (restored.length > 1) return { ok: false, error: "multiple_candidates" };

  // Re-check hash (belt and suspenders)
  if (restored[0].id_hash !== targetHash) {
    return { ok: false, error: "hash_mismatch" };
  }

  return { ok: true, candidate: restored[0] };
}

export type D1ExistingSafe = {
  id_hash: string;
  shop: string;
  is_online: boolean;
  expires_at: string | null;
  fingerprint: string;
};

export function classifyD1Conflict(
  candidate: SeedCandidate,
  existing: D1ExistingSafe | null,
): "insert" | "identical_skip" | "conflict" {
  if (!existing) return "insert";
  if (
    existing.id_hash === candidate.id_hash &&
    existing.shop === candidate.shop &&
    existing.is_online === candidate.is_online &&
    Boolean(existing.expires_at) === candidate.has_expires &&
    existing.fingerprint === candidate.fingerprint
  ) {
    return "identical_skip";
  }
  return "conflict";
}

export function buildD1RowFromCandidate(candidate: SeedCandidate): {
  id: string;
  shop: string;
  payload_json: string;
  is_online: number;
  expires_at: string | null;
  migration_source: string;
  migration_version: string;
} {
  // Use L1 serializer (not a fork)
  const payload = serializeSessionPayload(candidate.session);
  return {
    id: candidate.session.id,
    shop: candidate.session.shop,
    payload_json: JSON.stringify(payload),
    is_online: candidate.session.isOnline ? 1 : 0,
    expires_at:
      candidate.session.isOnline && candidate.session.expires
        ? candidate.session.expires.toISOString()
        : null,
    migration_source: "redis",
    migration_version: "l4.1-v1",
  };
}

export function safeMetaFromSession(session: Session, entryKeys: string[]) {
  return {
    id_hash: hashSessionId(session.id),
    shop: session.shop,
    is_online: Boolean(session.isOnline),
    has_expires: Boolean(session.expires),
    entry_keys: [...entryKeys].sort(),
    scope_hash: hashScope(session.scope),
    has_access_token: Boolean(session.accessToken),
    fingerprint: sessionFingerprint(session, entryKeys),
  };
}
