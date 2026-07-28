/**
 * D1-only Shopify session authority (Stage L6.0).
 *
 * D1 is the fixed session authority with no external fallback.
 */

import { createHash } from "node:crypto";
import type { Session } from "@shopify/shopify-api";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createShopifySessionRepository } from "~/lib/d1/shopifySessions.server";
import {
  classifyD1Error,
  type D1ErrorClass,
  type D1FailureStage,
  safeErrorName,
} from "~/lib/d1/errors.server";

/** Stable, non-reversible id hash for logs (never log the raw session id). */
export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

/** Align with primary/shadow/write budgets (L4.2b measured up to ~454ms). */
export const SESSION_D1_ONLY_TIMEOUT_MS = 500;

export type SessionD1OnlyLogCategory =
  | "session_d1_only_hit"
  | "session_d1_only_miss"
  | "session_d1_only_store_success"
  | "session_d1_only_store_error"
  | "session_d1_only_delete_success"
  | "session_d1_only_delete_error"
  | "session_d1_only_tombstone"
  | "session_d1_only_expired"
  | "session_d1_only_invalid"
  | "session_d1_only_timeout";

type LogFields = {
  category: SessionD1OnlyLogCategory;
  operation: "load" | "store" | "delete";
  returned_source: "d1" | "none";
  session_id_hash: string;
  latency_ms: number;
  shop?: string;
  applied?: boolean;
  error_class?: D1ErrorClass | "timeout" | "binding_missing";
  failure_stage?: D1FailureStage;
  error_name?: string;
  invalid_reason?: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("d1_only_timeout")), ms);
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

function emit(entry: LogFields): void {
  try {
    const line = JSON.stringify({
      type: entry.category,
      category: entry.category,
      operation: entry.operation,
      returned_source: entry.returned_source,
      session_id_hash: entry.session_id_hash,
      latency_ms: entry.latency_ms,
      shop: entry.shop,
      applied: entry.applied,
      error_class: entry.error_class,
      failure_stage: entry.failure_stage,
      error_name: entry.error_name,
      invalid_reason: entry.invalid_reason,
      primary_namespace: "d1_only",
    });
    if (/shpat_|sk_live|eyJhbGci/i.test(line)) return;
    console.log(line);
  } catch {
    // never affect session path
  }
}

function classifyFailure(error: unknown): {
  category: SessionD1OnlyLogCategory;
  error_class: D1ErrorClass | "timeout" | "binding_missing";
  failure_stage: D1FailureStage;
  error_name: string;
} {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("d1_only_timeout")) {
    return {
      category: "session_d1_only_timeout",
      error_class: "timeout",
      failure_stage: "timeout",
      error_name: safeErrorName(error),
    };
  }
  if (msg.includes("binding") && msg.includes("missing")) {
    return {
      category: "session_d1_only_store_error",
      error_class: "binding_missing",
      failure_stage: "binding",
      error_name: "binding_missing",
    };
  }
  const classified = classifyD1Error(error);
  return {
    category: "session_d1_only_store_error",
    error_class: classified.classification,
    failure_stage: classified.failureStage,
    error_name: safeErrorName(error),
  };
}

function requireDb(db?: D1Database): D1Database {
  const resolved = db ?? getOptionalTtiDb();
  if (!resolved) {
    throw new Error("D1 binding missing");
  }
  return resolved;
}

export async function loadSessionD1Only(params: {
  sessionId: string;
  db?: D1Database;
  timeoutMs?: number;
}): Promise<Session | undefined> {
  const started = Date.now();
  const idHash = hashSessionId(params.sessionId);
  const timeoutMs = params.timeoutMs ?? SESSION_D1_ONLY_TIMEOUT_MS;

  try {
    const db = requireDb(params.db);
    const repo = createShopifySessionRepository(db);
    const inspected = await withTimeout(
      repo.inspectSession(params.sessionId),
      timeoutMs,
    );
    const latency = Date.now() - started;

    if (inspected.status === "live") {
      emit({
        category: "session_d1_only_hit",
        operation: "load",
        returned_source: "d1",
        session_id_hash: idHash,
        latency_ms: latency,
      });
      return inspected.session;
    }
    if (inspected.status === "tombstone") {
      emit({
        category: "session_d1_only_tombstone",
        operation: "load",
        returned_source: "none",
        session_id_hash: idHash,
        latency_ms: latency,
      });
      return undefined;
    }
    if (inspected.status === "expired") {
      emit({
        category: "session_d1_only_expired",
        operation: "load",
        returned_source: "none",
        session_id_hash: idHash,
        latency_ms: latency,
      });
      return undefined;
    }
    if (inspected.status === "invalid") {
      emit({
        category: "session_d1_only_invalid",
        operation: "load",
        returned_source: "none",
        session_id_hash: idHash,
        latency_ms: latency,
        invalid_reason: inspected.reason,
      });
      return undefined;
    }
    emit({
      category: "session_d1_only_miss",
      operation: "load",
      returned_source: "none",
      session_id_hash: idHash,
      latency_ms: latency,
    });
    return undefined;
  } catch (error) {
    const latency = Date.now() - started;
    const fail = classifyFailure(error);
    emit({
      category:
        fail.error_class === "timeout"
          ? "session_d1_only_timeout"
          : fail.error_class === "binding_missing"
            ? "session_d1_only_miss"
            : "session_d1_only_invalid",
      operation: "load",
      returned_source: "none",
      session_id_hash: idHash,
      latency_ms: latency,
      error_class: fail.error_class,
      failure_stage: fail.failure_stage,
      error_name: fail.error_name,
    });
    // Safe miss, no throw (SessionStorage contract).
    return undefined;
  }
}

export async function storeSessionD1Only(params: {
  session: Session;
  db?: D1Database;
  timeoutMs?: number;
}): Promise<boolean> {
  const started = Date.now();
  const idHash = hashSessionId(params.session.id);
  const timeoutMs = params.timeoutMs ?? SESSION_D1_ONLY_TIMEOUT_MS;

  try {
    const db = requireDb(params.db);
    const repo = createShopifySessionRepository(db);
    const applied = await withTimeout(
      repo.storeSession(params.session),
      timeoutMs,
    );
    const latency = Date.now() - started;
    if (applied) {
      emit({
        category: "session_d1_only_store_success",
        operation: "store",
        returned_source: "d1",
        session_id_hash: idHash,
        latency_ms: latency,
        shop: params.session.shop,
        applied: true,
      });
      return true;
    }
    emit({
      category: "session_d1_only_store_error",
      operation: "store",
      returned_source: "none",
      session_id_hash: idHash,
      latency_ms: latency,
      shop: params.session.shop,
      applied: false,
      error_class: "constraint",
      failure_stage: "run",
      error_name: "stale_or_rejected",
    });
    return false;
  } catch (error) {
    const latency = Date.now() - started;
    const fail = classifyFailure(error);
    emit({
      category:
        fail.error_class === "timeout"
          ? "session_d1_only_timeout"
          : "session_d1_only_store_error",
      operation: "store",
      returned_source: "none",
      session_id_hash: idHash,
      latency_ms: latency,
      shop: params.session.shop,
      error_class: fail.error_class,
      failure_stage: fail.failure_stage,
      error_name: fail.error_name,
    });
    return false;
  }
}

export async function deleteSessionD1Only(params: {
  sessionId: string;
  shop?: string;
  db?: D1Database;
  timeoutMs?: number;
}): Promise<boolean> {
  const started = Date.now();
  const idHash = hashSessionId(params.sessionId);
  const timeoutMs = params.timeoutMs ?? SESSION_D1_ONLY_TIMEOUT_MS;

  try {
    const db = requireDb(params.db);
    const repo = createShopifySessionRepository(db);
    // Prefer shop from live/tombstone row when caller omits it.
    let shop = params.shop || "";
    if (!shop) {
      const inspected = await repo.inspectSession(params.sessionId);
      if (inspected.status !== "missing" && "row" in inspected && inspected.row) {
        shop = inspected.row.shop || "";
      }
    }
    const applied = await withTimeout(
      repo.deleteSession(params.sessionId, { shop }),
      timeoutMs,
    );
    const latency = Date.now() - started;
    emit({
      category: "session_d1_only_delete_success",
      operation: "delete",
      returned_source: applied ? "d1" : "none",
      session_id_hash: idHash,
      latency_ms: latency,
      shop: shop || undefined,
      applied,
    });
    // Idempotent delete: treat as success for SessionStorage logout contract
    // when row already tombstoned / missing after attempt.
    return true;
  } catch (error) {
    const latency = Date.now() - started;
    const fail = classifyFailure(error);
    emit({
      category:
        fail.error_class === "timeout"
          ? "session_d1_only_timeout"
          : "session_d1_only_delete_error",
      operation: "delete",
      returned_source: "none",
      session_id_hash: idHash,
      latency_ms: latency,
      shop: params.shop,
      error_class: fail.error_class,
      failure_stage: fail.failure_stage,
      error_name: fail.error_name,
    });
    return false;
  }
}

export async function findSessionsByShopD1Only(params: {
  shop: string;
  db?: D1Database;
  timeoutMs?: number;
}): Promise<Session[]> {
  try {
    const db = requireDb(params.db);
    const repo = createShopifySessionRepository(db);
    return await withTimeout(
      repo.findSessionsByShop(params.shop),
      params.timeoutMs ?? SESSION_D1_ONLY_TIMEOUT_MS,
    );
  } catch {
    return [];
  }
}
