/**
 * D1 Shopify session dual-write (Stage L4.3).
 *
 * Redis remains sole authority. Call only after Redis store/delete succeeds.
 * Awaited in-request (not waitUntil) so same-request store→delete ordering holds.
 *
 * Stale-store resurrection after delete is blocked in the repository via
 * soft-delete tombstones + updated_at conditional upsert (not unbounded retry).
 */

import type { Session } from "@shopify/shopify-api";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createShopifySessionRepository } from "~/lib/d1/shopifySessions.server";
import { classifyD1Error, safeErrorName } from "~/lib/d1/errors.server";
import { isSessionD1DualWriteActive } from "~/lib/sessionD1Mode.server";
import { hashSessionId } from "~/lib/sessionD1Shadow.server";

/**
 * Mirror budget. Same order as shadow (500ms): Redis auth already finished;
 * bound Worker time without waitUntil races.
 */
export const SESSION_D1_WRITE_TIMEOUT_MS = 500;

type DualWriteLogType =
  | "session_d1_write_success"
  | "session_d1_write_error"
  | "session_d1_write_timeout"
  | "session_d1_delete_success"
  | "session_d1_delete_error"
  | "session_d1_delete_timeout";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("d1_dual_write_timeout")), ms);
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

function logDualWrite(entry: {
  type: DualWriteLogType;
  operation: "store" | "delete";
  session_id_hash: string;
  shop: string;
  latency_ms: number;
  error_class?: string;
  error_name?: string;
  failure_stage?: string;
  applied?: boolean;
}): void {
  try {
    const line = JSON.stringify({
      ...entry,
      primary_namespace: "tti",
      returned_source: "redis",
    });
    if (/shpat_|sk_live|eyJhbGci/i.test(line)) return;
    console.log(line);
  } catch {
    // never affect Redis path
  }
}

/**
 * After Redis storeSession succeeds: upsert the same session into D1.
 * Never throws to caller; Redis result must stay authoritative.
 */
export async function mirrorSessionStoreToD1(session: Session): Promise<void> {
  if (!isSessionD1DualWriteActive()) return;

  const started = Date.now();
  const idHash = hashSessionId(session.id);
  const shop = session.shop || "";
  const db = getOptionalTtiDb();
  if (!db) {
    logDualWrite({
      type: "session_d1_write_error",
      operation: "store",
      session_id_hash: idHash,
      shop,
      latency_ms: 0,
      error_class: "binding_missing",
      error_name: "BindingMissing",
      failure_stage: "binding",
    });
    return;
  }

  try {
    const repo = createShopifySessionRepository(db);
    const applied = await withTimeout(
      repo.storeSession(session),
      SESSION_D1_WRITE_TIMEOUT_MS,
    );
    logDualWrite({
      type: "session_d1_write_success",
      operation: "store",
      session_id_hash: idHash,
      shop,
      latency_ms: Date.now() - started,
      applied,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "d1_dual_write_timeout" || /timeout/i.test(message)) {
      logDualWrite({
        type: "session_d1_write_timeout",
        operation: "store",
        session_id_hash: idHash,
        shop,
        latency_ms: SESSION_D1_WRITE_TIMEOUT_MS,
        error_class: "timeout",
        error_name: safeErrorName(error),
        failure_stage: "timeout",
      });
      return;
    }
    const classified = classifyD1Error(error);
    logDualWrite({
      type: "session_d1_write_error",
      operation: "store",
      session_id_hash: idHash,
      shop,
      latency_ms: Date.now() - started,
      error_class: classified.classification,
      error_name: safeErrorName(error),
      failure_stage: classified.failureStage,
    });
  }
}

/**
 * After Redis deleteSession succeeds: soft-delete in D1 (tombstone).
 * Soft-delete + updated_at guard prevents a delayed/stale store from resurrecting.
 */
export async function mirrorSessionDeleteToD1(params: {
  sessionId: string;
  shop?: string;
}): Promise<void> {
  if (!isSessionD1DualWriteActive()) return;

  const started = Date.now();
  const idHash = hashSessionId(params.sessionId);
  const shop = params.shop || "";
  const db = getOptionalTtiDb();
  if (!db) {
    logDualWrite({
      type: "session_d1_delete_error",
      operation: "delete",
      session_id_hash: idHash,
      shop,
      latency_ms: 0,
      error_class: "binding_missing",
      error_name: "BindingMissing",
      failure_stage: "binding",
    });
    return;
  }

  try {
    const repo = createShopifySessionRepository(db);
    const applied = await withTimeout(
      repo.deleteSession(params.sessionId, { shop: params.shop }),
      SESSION_D1_WRITE_TIMEOUT_MS,
    );
    logDualWrite({
      type: "session_d1_delete_success",
      operation: "delete",
      session_id_hash: idHash,
      shop,
      latency_ms: Date.now() - started,
      applied,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "d1_dual_write_timeout" || /timeout/i.test(message)) {
      logDualWrite({
        type: "session_d1_delete_timeout",
        operation: "delete",
        session_id_hash: idHash,
        shop,
        latency_ms: SESSION_D1_WRITE_TIMEOUT_MS,
        error_class: "timeout",
        error_name: safeErrorName(error),
        failure_stage: "timeout",
      });
      return;
    }
    const classified = classifyD1Error(error);
    logDualWrite({
      type: "session_d1_delete_error",
      operation: "delete",
      session_id_hash: idHash,
      shop,
      latency_ms: Date.now() - started,
      error_class: classified.classification,
      error_name: safeErrorName(error),
      failure_stage: classified.failureStage,
    });
  }
}
