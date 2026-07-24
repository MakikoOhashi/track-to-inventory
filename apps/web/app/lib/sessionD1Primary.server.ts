/**
 * D1 primary session load with Redis fallback (Stage L4.4a).
 *
 * Active only when SESSION_D1_MODE=d1_primary.
 * Never read-repairs D1 from Redis. Never revives tombstone/expired via Redis.
 * Store/delete remain Redis-primary + D1 dual-write (see sessionD1DualWrite).
 */

import type { Session } from "@shopify/shopify-api";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import {
  createShopifySessionRepository,
  type D1SessionInspectResult,
} from "~/lib/d1/shopifySessions.server";
import {
  classifyD1Error,
  type D1ErrorClass,
  type D1FailureStage,
  safeErrorName,
} from "~/lib/d1/errors.server";
import { isSessionD1PrimaryActive } from "~/lib/sessionD1Mode.server";
import {
  hashSessionId,
  type RedisSessionNamespace,
} from "~/lib/sessionD1Shadow.server";

/**
 * D1 primary read budget (Stage L4.4a).
 *
 * Aligns with SESSION_D1_SHADOW_TIMEOUT_MS / SESSION_D1_WRITE_TIMEOUT_MS (500).
 * L4.2b spaced production reads measured match latencies up to ~454ms; a shorter
 * primary budget would force false Redis fallbacks on warm-but-slow D1 paths.
 * Do not raise further without fresh p95 evidence under dual_write traffic.
 */
export const SESSION_D1_PRIMARY_TIMEOUT_MS = 500;

export type SessionReturnedSource = "d1" | "redis" | "none";

export type SessionD1PrimaryFallbackReason =
  | "missing"
  | "invalid"
  | "error"
  | "timeout"
  | "binding_missing"
  | null;

export type SessionD1PrimaryLogCategory =
  | "session_d1_primary_hit"
  | "session_d1_primary_miss"
  | "session_d1_primary_tombstone"
  | "session_d1_primary_expired"
  | "session_d1_primary_invalid"
  | "session_d1_primary_error"
  | "session_d1_primary_timeout"
  | "session_redis_fallback_success"
  | "session_redis_fallback_miss"
  | "session_load_failed";

export type SessionD1PrimaryLoadResult = {
  session: Session | undefined;
  returned_source: SessionReturnedSource;
  fallback_reason: SessionD1PrimaryFallbackReason;
  d1_latency_ms: number;
  redis_fallback_latency_ms: number | null;
  total_latency_ms: number;
  d1_updated_at: string | null;
  logs: SessionD1PrimaryLogEntry[];
};

export type SessionD1PrimaryLogEntry = {
  category: SessionD1PrimaryLogCategory;
  returned_source: SessionReturnedSource;
  fallback_reason: SessionD1PrimaryFallbackReason;
  session_id_hash: string;
  d1_latency_ms: number;
  redis_fallback_latency_ms?: number | null;
  total_latency_ms: number;
  error_class?: D1ErrorClass | "timeout";
  failure_stage?: D1FailureStage;
  error_name?: string;
  invalid_reason?: string;
  d1_updated_at?: string | null;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("d1_primary_timeout")), ms);
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

function emitLog(entry: SessionD1PrimaryLogEntry): void {
  try {
    const line = JSON.stringify({
      type: entry.category,
      category: entry.category,
      returned_source: entry.returned_source,
      fallback_reason: entry.fallback_reason,
      session_id_hash: entry.session_id_hash,
      d1_latency_ms: entry.d1_latency_ms,
      redis_fallback_latency_ms: entry.redis_fallback_latency_ms ?? null,
      total_latency_ms: entry.total_latency_ms,
      error_class: entry.error_class,
      failure_stage: entry.failure_stage,
      error_name: entry.error_name,
      invalid_reason: entry.invalid_reason,
      d1_updated_at: entry.d1_updated_at ?? null,
      primary_namespace: "d1_primary",
    });
    if (/shpat_|sk_live|eyJhbGci/i.test(line)) return;
    console.log(line);
  } catch {
    // never affect load path
  }
}

function rowUpdatedAt(inspected: D1SessionInspectResult): string | null {
  if (inspected.status === "missing") return null;
  if ("row" in inspected && inspected.row) {
    return inspected.row.updated_at ?? null;
  }
  return null;
}

/**
 * Load session with D1 as read primary. Redis is fallback only.
 * Does not write to D1 or Redis.
 */
export async function loadSessionD1Primary(params: {
  sessionId: string;
  loadFromRedis: () => Promise<{
    session: Session | undefined;
    namespace: RedisSessionNamespace;
  }>;
  /** Test injection; production uses ALS TTI_DB. */
  db?: D1Database;
  /** Override timeout (tests). */
  timeoutMs?: number;
}): Promise<SessionD1PrimaryLoadResult> {
  const totalStarted = Date.now();
  const idHash = hashSessionId(params.sessionId);
  const timeoutMs = params.timeoutMs ?? SESSION_D1_PRIMARY_TIMEOUT_MS;
  const logs: SessionD1PrimaryLogEntry[] = [];

  const push = (entry: Omit<SessionD1PrimaryLogEntry, "session_id_hash">) => {
    const full: SessionD1PrimaryLogEntry = {
      ...entry,
      session_id_hash: idHash,
    };
    logs.push(full);
    emitLog(full);
  };

  if (!isSessionD1PrimaryActive()) {
    const redisStarted = Date.now();
    const { session } = await params.loadFromRedis();
    const total = Date.now() - totalStarted;
    return {
      session,
      returned_source: session ? "redis" : "none",
      fallback_reason: null,
      d1_latency_ms: 0,
      redis_fallback_latency_ms: Date.now() - redisStarted,
      total_latency_ms: total,
      d1_updated_at: null,
      logs,
    };
  }

  const db = params.db ?? getOptionalTtiDb();
  if (!db) {
    const d1Latency = 0;
    push({
      category: "session_d1_primary_error",
      returned_source: "none",
      fallback_reason: "binding_missing",
      d1_latency_ms: d1Latency,
      total_latency_ms: Date.now() - totalStarted,
      error_class: "fatal",
      failure_stage: "binding",
      error_name: "binding_missing",
    });
    return fallbackRedis({
      loadFromRedis: params.loadFromRedis,
      totalStarted,
      d1Latency,
      fallbackReason: "binding_missing",
      d1UpdatedAt: null,
      push,
      logs,
    });
  }

  const d1Started = Date.now();
  let inspected: D1SessionInspectResult | undefined;
  let d1Error: unknown;

  try {
    const repo = createShopifySessionRepository(db);
    inspected = await withTimeout(repo.inspectSession(params.sessionId), timeoutMs);
  } catch (error) {
    d1Error = error;
  }

  const d1Latency = Date.now() - d1Started;

  if (d1Error) {
    const msg = d1Error instanceof Error ? d1Error.message : String(d1Error);
    const isTimeout = msg.includes("d1_primary_timeout");
    if (isTimeout) {
      push({
        category: "session_d1_primary_timeout",
        returned_source: "none",
        fallback_reason: "timeout",
        d1_latency_ms: d1Latency,
        total_latency_ms: Date.now() - totalStarted,
        error_class: "timeout",
        failure_stage: "timeout",
        error_name: safeErrorName(d1Error),
      });
      return fallbackRedis({
        loadFromRedis: params.loadFromRedis,
        totalStarted,
        d1Latency,
        fallbackReason: "timeout",
        d1UpdatedAt: null,
        push,
        logs,
      });
    }

    const classified = classifyD1Error(d1Error);
    push({
      category: "session_d1_primary_error",
      returned_source: "none",
      fallback_reason: "error",
      d1_latency_ms: d1Latency,
      total_latency_ms: Date.now() - totalStarted,
      error_class: classified.classification,
      failure_stage: classified.failureStage,
      error_name: safeErrorName(d1Error),
    });
    return fallbackRedis({
      loadFromRedis: params.loadFromRedis,
      totalStarted,
      d1Latency,
      fallbackReason: "error",
      d1UpdatedAt: null,
      push,
      logs,
    });
  }

  const result = inspected!;
  const updatedAt = rowUpdatedAt(result);

  if (result.status === "live") {
    const total = Date.now() - totalStarted;
    push({
      category: "session_d1_primary_hit",
      returned_source: "d1",
      fallback_reason: null,
      d1_latency_ms: d1Latency,
      redis_fallback_latency_ms: null,
      total_latency_ms: total,
      d1_updated_at: updatedAt,
    });
    return {
      session: result.session,
      returned_source: "d1",
      fallback_reason: null,
      d1_latency_ms: d1Latency,
      redis_fallback_latency_ms: null,
      total_latency_ms: total,
      d1_updated_at: updatedAt,
      logs,
    };
  }

  if (result.status === "tombstone") {
    const total = Date.now() - totalStarted;
    push({
      category: "session_d1_primary_tombstone",
      returned_source: "none",
      fallback_reason: null,
      d1_latency_ms: d1Latency,
      redis_fallback_latency_ms: null,
      total_latency_ms: total,
      d1_updated_at: updatedAt,
    });
    return {
      session: undefined,
      returned_source: "none",
      fallback_reason: null,
      d1_latency_ms: d1Latency,
      redis_fallback_latency_ms: null,
      total_latency_ms: total,
      d1_updated_at: updatedAt,
      logs,
    };
  }

  if (result.status === "expired") {
    const total = Date.now() - totalStarted;
    push({
      category: "session_d1_primary_expired",
      returned_source: "none",
      fallback_reason: null,
      d1_latency_ms: d1Latency,
      redis_fallback_latency_ms: null,
      total_latency_ms: total,
      d1_updated_at: updatedAt,
    });
    return {
      session: undefined,
      returned_source: "none",
      fallback_reason: null,
      d1_latency_ms: d1Latency,
      redis_fallback_latency_ms: null,
      total_latency_ms: total,
      d1_updated_at: updatedAt,
      logs,
    };
  }

  if (result.status === "invalid") {
    push({
      category: "session_d1_primary_invalid",
      returned_source: "none",
      fallback_reason: "invalid",
      d1_latency_ms: d1Latency,
      total_latency_ms: Date.now() - totalStarted,
      invalid_reason: result.reason,
      d1_updated_at: updatedAt,
    });
    return fallbackRedis({
      loadFromRedis: params.loadFromRedis,
      totalStarted,
      d1Latency,
      fallbackReason: "invalid",
      d1UpdatedAt: updatedAt,
      push,
      logs,
    });
  }

  // missing
  push({
    category: "session_d1_primary_miss",
    returned_source: "none",
    fallback_reason: "missing",
    d1_latency_ms: d1Latency,
    total_latency_ms: Date.now() - totalStarted,
    d1_updated_at: null,
  });
  return fallbackRedis({
    loadFromRedis: params.loadFromRedis,
    totalStarted,
    d1Latency,
    fallbackReason: "missing",
    d1UpdatedAt: null,
    push,
    logs,
  });
}

async function fallbackRedis(params: {
  loadFromRedis: () => Promise<{
    session: Session | undefined;
    namespace: RedisSessionNamespace;
  }>;
  totalStarted: number;
  d1Latency: number;
  fallbackReason: Exclude<SessionD1PrimaryFallbackReason, null>;
  d1UpdatedAt: string | null;
  push: (entry: Omit<SessionD1PrimaryLogEntry, "session_id_hash">) => void;
  logs: SessionD1PrimaryLogEntry[];
}): Promise<SessionD1PrimaryLoadResult> {
  const redisStarted = Date.now();
  let session: Session | undefined;
  let redisError: unknown;

  try {
    const loaded = await params.loadFromRedis();
    session = loaded.session;
  } catch (error) {
    redisError = error;
  }

  const redisLatency = Date.now() - redisStarted;
  const total = Date.now() - params.totalStarted;

  if (redisError) {
    params.push({
      category: "session_load_failed",
      returned_source: "none",
      fallback_reason: params.fallbackReason,
      d1_latency_ms: params.d1Latency,
      redis_fallback_latency_ms: redisLatency,
      total_latency_ms: total,
      error_class: "unknown",
      failure_stage: "unknown",
      error_name: safeErrorName(redisError),
      d1_updated_at: params.d1UpdatedAt,
    });
    return {
      session: undefined,
      returned_source: "none",
      fallback_reason: params.fallbackReason,
      d1_latency_ms: params.d1Latency,
      redis_fallback_latency_ms: redisLatency,
      total_latency_ms: total,
      d1_updated_at: params.d1UpdatedAt,
      logs: params.logs,
    };
  }

  if (session) {
    params.push({
      category: "session_redis_fallback_success",
      returned_source: "redis",
      fallback_reason: params.fallbackReason,
      d1_latency_ms: params.d1Latency,
      redis_fallback_latency_ms: redisLatency,
      total_latency_ms: total,
      d1_updated_at: params.d1UpdatedAt,
    });
    return {
      session,
      returned_source: "redis",
      fallback_reason: params.fallbackReason,
      d1_latency_ms: params.d1Latency,
      redis_fallback_latency_ms: redisLatency,
      total_latency_ms: total,
      d1_updated_at: params.d1UpdatedAt,
      logs: params.logs,
    };
  }

  params.push({
    category: "session_redis_fallback_miss",
    returned_source: "none",
    fallback_reason: params.fallbackReason,
    d1_latency_ms: params.d1Latency,
    redis_fallback_latency_ms: redisLatency,
    total_latency_ms: total,
    d1_updated_at: params.d1UpdatedAt,
  });
  return {
    session: undefined,
    returned_source: "none",
    fallback_reason: params.fallbackReason,
    d1_latency_ms: params.d1Latency,
    redis_fallback_latency_ms: redisLatency,
    total_latency_ms: total,
    d1_updated_at: params.d1UpdatedAt,
    logs: params.logs,
  };
}
