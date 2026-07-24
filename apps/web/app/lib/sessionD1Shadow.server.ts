/**
 * D1 Shopify session shadow read (Stage L4.2).
 * Never returns D1 data to callers; never rescues Redis misses from D1.
 */

import { createHash } from "node:crypto";
import type { Session } from "@shopify/shopify-api";
import {
  getCloudflareCtx,
  getOptionalTtiDb,
} from "~/lib/cloudflareBindings.server";
import { createShopifySessionRepository } from "~/lib/d1/shopifySessions.server";
import { classifyD1Error } from "~/lib/d1/errors.server";
import { isSessionD1ShadowActive } from "~/lib/sessionD1Mode.server";

/**
 * D1 shadow compare budget (Stage L4.2b).
 *
 * History: L4.2a saw a first-read `d1_timeout` at 200ms (then warm match ~20ms).
 * That is treated as measured first-read latency (Worker/D1/tail path), not a
 * proven "D1 cold start" root cause.
 *
 * 500ms: absorbs that first-read spike without blocking Redis auth (shadow runs
 * in waitUntil). Typical APAC D1 reads remain ≪50ms. Do not raise further on a
 * single timeout — another hit at 500ms keeps L4.3 unapproved.
 */
export const SESSION_D1_SHADOW_TIMEOUT_MS = 500;

export type SessionShadowCategory =
  | "match"
  | "missing_in_d1"
  | "missing_in_redis"
  | "shop_mismatch"
  | "online_mismatch"
  | "expiry_mismatch"
  | "scope_mismatch"
  | "token_mismatch"
  | "state_mismatch"
  | "serializer_mismatch"
  | "malformed_d1"
  | "d1_error"
  | "d1_timeout";

export type RedisSessionNamespace = "tti" | "legacy" | "miss";

export type SessionShadowSnap = {
  id_hash: string;
  shop: string;
  is_online: boolean;
  has_expires: boolean;
  expires_ms: number | null;
  has_user_id: boolean;
  scope_fp: string | null;
  token_fp: string | null;
  state_fp: string | null;
  entry_keys: string[];
  semantic_fp: string;
};

let matchLogCount = 0;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashSessionId(id: string): string {
  return sha256Hex(id).slice(0, 16);
}

export function fingerprintSecret(value: string | undefined | null): string | null {
  if (value == null || value === "") return null;
  return sha256Hex(value).slice(0, 16);
}

export function snapFromSession(session: Session): SessionShadowSnap {
  const entries = session.toPropertyArray(true);
  const entryKeys = entries.map(([k]) => String(k)).sort();
  const stateEntry = entries.find(([k]) => k === "state");
  const stateVal =
    stateEntry &&
    (typeof stateEntry[1] === "string" || typeof stateEntry[1] === "number")
      ? String(stateEntry[1])
      : null;
  const onlineInfo = (
    session as { onlineAccessInfo?: { associated_user?: { id?: number } } }
  ).onlineAccessInfo;

  const tokenFp = fingerprintSecret(session.accessToken);
  const stateFp = fingerprintSecret(stateVal);
  const scopeFp = fingerprintSecret(session.scope || null);
  const expiresMs = session.expires ? session.expires.getTime() : null;

  const semantic_fp = sha256Hex(
    [
      session.id,
      session.shop,
      String(session.isOnline),
      session.scope || "",
      expiresMs == null ? "" : String(expiresMs),
      tokenFp || "",
      stateFp || "",
      entryKeys.join(","),
    ].join("|"),
  ).slice(0, 24);

  return {
    id_hash: hashSessionId(session.id),
    shop: session.shop,
    is_online: Boolean(session.isOnline),
    has_expires: expiresMs != null,
    expires_ms: expiresMs,
    has_user_id: Boolean(onlineInfo?.associated_user?.id),
    scope_fp: scopeFp,
    token_fp: tokenFp,
    state_fp: stateFp,
    entry_keys: entryKeys,
    semantic_fp,
  };
}

export function classifySessionShadow(
  redis: SessionShadowSnap | null,
  d1: SessionShadowSnap | null,
): SessionShadowCategory {
  if (redis && !d1) return "missing_in_d1";
  if (!redis && d1) return "missing_in_redis";
  if (!redis && !d1) return "missing_in_d1";

  const r = redis!;
  const d = d1!;

  if (r.shop !== d.shop) return "shop_mismatch";
  if (r.is_online !== d.is_online) return "online_mismatch";
  if (r.expires_ms !== d.expires_ms) return "expiry_mismatch";
  if (r.scope_fp !== d.scope_fp) return "scope_mismatch";
  if (r.token_fp !== d.token_fp) return "token_mismatch";
  if (r.state_fp !== d.state_fp) return "state_mismatch";

  if (r.entry_keys.join(",") !== d.entry_keys.join(",")) {
    return "serializer_mismatch";
  }

  if (r.semantic_fp === d.semantic_fp && r.id_hash === d.id_hash) return "match";
  return "serializer_mismatch";
}

export function logSessionD1ShadowDiff(payload: {
  correlation_id: string;
  session_id_hash: string;
  shop: string;
  primary_namespace: RedisSessionNamespace;
  category: SessionShadowCategory;
  latency_ms: number;
  error_class?: string;
  redis_online?: boolean | null;
  redis_has_expires?: boolean | null;
  d1_online?: boolean | null;
  d1_has_expires?: boolean | null;
  entry_keys?: string[];
}): void {
  if (payload.category === "match") {
    matchLogCount += 1;
    if (
      matchLogCount > 3 &&
      matchLogCount % 25 !== 0 &&
      process.env.SESSION_D1_SHADOW_LOG_ALL_MATCHES !== "1"
    ) {
      return;
    }
  }

  try {
    console.log(
      JSON.stringify({
        type: "shopify_session_d1_shadow_diff",
        ...payload,
      }),
    );
  } catch {
    // logging failure must not affect auth
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("d1_shadow_timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function compareSessionToD1(params: {
  db: D1Database;
  sessionId: string;
  redisSession: Session | undefined;
  primaryNamespace: RedisSessionNamespace;
  correlationId?: string;
}): Promise<SessionShadowCategory> {
  const started = Date.now();
  const correlationId = params.correlationId || crypto.randomUUID();
  const redisSnap = params.redisSession
    ? snapFromSession(params.redisSession)
    : null;
  const idHash = hashSessionId(
    params.redisSession?.id || params.sessionId,
  );

  // db must be passed from request context — never re-read ALS here
  // (waitUntil callbacks lose AsyncLocalStorage).
  try {
    const repo = createShopifySessionRepository(params.db);
    let d1Session: Session | undefined;
    try {
      d1Session = await repo.loadSession(params.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/JSON|parse|malformed/i.test(message)) {
        logSessionD1ShadowDiff({
          correlation_id: correlationId,
          session_id_hash: idHash,
          shop: redisSnap?.shop || "",
          primary_namespace: params.primaryNamespace,
          category: "malformed_d1",
          latency_ms: Date.now() - started,
          error_class: "malformed",
          redis_online: redisSnap?.is_online ?? null,
          redis_has_expires: redisSnap?.has_expires ?? null,
        });
        return "malformed_d1";
      }
      const classified = classifyD1Error(error);
      logSessionD1ShadowDiff({
        correlation_id: correlationId,
        session_id_hash: idHash,
        shop: redisSnap?.shop || "",
        primary_namespace: params.primaryNamespace,
        category: "d1_error",
        latency_ms: Date.now() - started,
        error_class: classified.classification,
        redis_online: redisSnap?.is_online ?? null,
        redis_has_expires: redisSnap?.has_expires ?? null,
      });
      return "d1_error";
    }

    const d1Snap = d1Session ? snapFromSession(d1Session) : null;
    const category = classifySessionShadow(redisSnap, d1Snap);
    logSessionD1ShadowDiff({
      correlation_id: correlationId,
      session_id_hash: idHash,
      shop: redisSnap?.shop || d1Snap?.shop || "",
      primary_namespace: params.primaryNamespace,
      category,
      latency_ms: Date.now() - started,
      redis_online: redisSnap?.is_online ?? null,
      redis_has_expires: redisSnap?.has_expires ?? null,
      d1_online: d1Snap?.is_online ?? null,
      d1_has_expires: d1Snap?.has_expires ?? null,
      entry_keys: redisSnap?.entry_keys || d1Snap?.entry_keys,
    });
    return category;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const category: SessionShadowCategory =
      message === "d1_shadow_timeout" || /timeout/i.test(message)
        ? "d1_timeout"
        : "d1_error";
    logSessionD1ShadowDiff({
      correlation_id: correlationId,
      session_id_hash: idHash,
      shop: redisSnap?.shop || "",
      primary_namespace: params.primaryNamespace,
      category,
      latency_ms: Date.now() - started,
      error_class: category === "d1_timeout" ? "timeout" : "unknown",
      redis_online: redisSnap?.is_online ?? null,
      redis_has_expires: redisSnap?.has_expires ?? null,
    });
    return category;
  }
}

/**
 * Capture D1 + ctx in request scope, then run compare inside waitUntil
 * with an explicit db argument (ALS is unreliable after waitUntil).
 */
export function scheduleSessionD1Shadow(params: {
  sessionId: string;
  redisSession: Session | undefined;
  primaryNamespace: RedisSessionNamespace;
}): void {
  if (!isSessionD1ShadowActive()) return;

  const idHash = hashSessionId(params.sessionId);
  const redisOnline = params.redisSession
    ? Boolean(params.redisSession.isOnline)
    : null;
  const redisHasExpires = Boolean(params.redisSession?.expires);
  const shop = params.redisSession?.shop || "";

  // Resolve binding NOW while request ALS is valid.
  const db = getOptionalTtiDb();
  if (!db) {
    logSessionD1ShadowDiff({
      correlation_id: crypto.randomUUID(),
      session_id_hash: idHash,
      shop,
      primary_namespace: params.primaryNamespace,
      category: "d1_error",
      latency_ms: 0,
      error_class: "binding_missing",
      redis_online: redisOnline,
      redis_has_expires: redisHasExpires,
    });
    // Do not register incomplete waitUntil work.
    return;
  }

  const ctx = getCloudflareCtx();

  const work = withTimeout(
    compareSessionToD1({
      db,
      sessionId: params.sessionId,
      redisSession: params.redisSession,
      primaryNamespace: params.primaryNamespace,
    }),
    SESSION_D1_SHADOW_TIMEOUT_MS,
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "d1_shadow_timeout" || /timeout/i.test(message)) {
      logSessionD1ShadowDiff({
        correlation_id: crypto.randomUUID(),
        session_id_hash: idHash,
        shop,
        primary_namespace: params.primaryNamespace,
        category: "d1_timeout",
        latency_ms: SESSION_D1_SHADOW_TIMEOUT_MS,
        error_class: "timeout",
        redis_online: redisOnline,
        redis_has_expires: redisHasExpires,
      });
    }
  });

  try {
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(work);
    } else {
      void work;
    }
  } catch {
    // waitUntil registration failure must not affect Redis auth
    void work;
  }
}

export function resetSessionShadowMatchLogCount(): void {
  matchLogCount = 0;
}

/** Awaitable shadow for tests — pass db explicitly (simulates waitUntil handoff). */
export async function runSessionD1ShadowForTest(params: {
  db?: D1Database;
  sessionId: string;
  redisSession: Session | undefined;
  primaryNamespace: RedisSessionNamespace;
}): Promise<SessionShadowCategory | "skipped"> {
  if (!isSessionD1ShadowActive()) return "skipped";
  if (!params.db) {
    logSessionD1ShadowDiff({
      correlation_id: crypto.randomUUID(),
      session_id_hash: hashSessionId(params.sessionId),
      shop: params.redisSession?.shop || "",
      primary_namespace: params.primaryNamespace,
      category: "d1_error",
      latency_ms: 0,
      error_class: "binding_missing",
      redis_online: params.redisSession
        ? Boolean(params.redisSession.isOnline)
        : null,
      redis_has_expires: Boolean(params.redisSession?.expires),
    });
    return "d1_error";
  }
  try {
    return await withTimeout(
      compareSessionToD1({
        db: params.db,
        sessionId: params.sessionId,
        redisSession: params.redisSession,
        primaryNamespace: params.primaryNamespace,
      }),
      SESSION_D1_SHADOW_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "d1_shadow_timeout") return "d1_timeout";
    return "d1_error";
  }
}
