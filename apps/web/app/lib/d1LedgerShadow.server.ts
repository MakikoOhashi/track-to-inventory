/**
 * D1 inventory ledger shadow (Stage L2 / L7.1).
 * Performs **actual D1 writes** (claim / finalize / markAmbiguous) for parity comparison;
 * not read-only simulation. Never influences Shopify mutation authorization.
 * Failures are logged as comparison categories only.
 */

import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import {
  createInventorySyncLedgerRepository,
  classifyD1Error,
} from "~/lib/d1/index.server";
import type { LedgerClaimResult as D1ClaimResult } from "~/lib/d1/types.server";
import {
  getD1LedgerMode,
  isD1LedgerShadowActive,
} from "~/lib/d1LedgerMode.server";
import type {
  ClaimResult,
  LedgerClaimAction,
  LedgerRow,
  LedgerStatus,
} from "~/lib/syncLedger.server";

export type D1ShadowCompareClass =
  | "already_synced_match"
  | "claimable_match"
  | "status_mismatch"
  | "missing_in_d1"
  | "missing_in_primary"
  | "d1_error"
  | "d1_timeout"
  | "claim_owner_mismatch"
  | "finalize_mismatch"
  | "busy_match"
  | "ambiguous_match"
  | "terminal_match"
  | "skipped_off";

export type D1ShadowLog = {
  type: "invsync_d1_shadow_diff";
  correlation_id: string;
  shop_id: string;
  category: D1ShadowCompareClass;
  primary_action: string;
  shadow_action: string;
  latency_ms: number;
  error_class?: string;
  phase: "claim" | "finalize" | "stale";
};

function safeShopId(shopId: string): string {
  // Keep domain (already used elsewhere); never log tokens.
  return shopId.slice(0, 80);
}

export function classifyD1ShadowClaim(
  primary: ClaimResult,
  shadow: ClaimResult & { missing?: boolean },
): D1ShadowCompareClass {
  if (shadow.missing && primary.action !== "error") return "missing_in_d1";
  if (primary.action === "error" && shadow.action !== "error") {
    return "missing_in_primary";
  }

  if (primary.action === shadow.action) {
    if (primary.action === "already_synced") return "already_synced_match";
    if (primary.action === "claimed") return "claimable_match";
    if (primary.action === "in_progress") return "busy_match";
    if (primary.action === "manual_review") return "ambiguous_match";
    if (primary.action === "terminal") return "terminal_match";
    return "claimable_match";
  }

  if (
    primary.row &&
    shadow.row &&
    primary.row.status !== shadow.row.status
  ) {
    return "status_mismatch";
  }
  return "status_mismatch";
}

export function logD1ShadowDiff(payload: Omit<D1ShadowLog, "type">): void {
  console.log(
    JSON.stringify({
      type: "invsync_d1_shadow_diff",
      ...payload,
    }),
  );
}

function toClaimResultFromD1(result: D1ClaimResult): ClaimResult {
  return {
    action: result.action as LedgerClaimAction,
    row: result.row
      ? ({
          id: result.row.id,
          shop_id: result.row.shop_id,
          si_number: result.row.si_number,
          item_key: result.row.item_key,
          variant_id: result.row.variant_id,
          inventory_item_id: result.row.inventory_item_id,
          location_id: result.row.location_id,
          delta_quantity: result.row.delta_quantity,
          idempotency_key: result.row.idempotency_key,
          status: result.row.status,
          attempt_count: result.row.attempt_count,
          started_at: result.row.started_at,
          completed_at: result.row.completed_at,
          shopify_adjustment_id: result.row.shopify_adjustment_id,
          error_code: result.row.error_code,
          error_message: result.row.error_message,
          claim_token: result.row.claim_token,
        } satisfies LedgerRow)
      : undefined,
    error_code: result.error_code,
  };
}

function isTimeoutError(message: string): boolean {
  return /timeout|timed out|deadline/i.test(message);
}

/**
 * After Supabase (primary) claim — mirror claim on D1 for comparison.
 * Never throws; never changes primary result.
 */
export async function shadowClaimOnD1(params: {
  correlationId: string;
  primary: ClaimResult;
  shopId: string;
  siNumber: string;
  itemKey: string;
  variantId: string;
  deltaQuantity: number;
  idempotencyKey: string;
}): Promise<void> {
  if (!isD1LedgerShadowActive()) return;

  const mode = getD1LedgerMode();
  if (mode === "primary") {
    console.log(
      JSON.stringify({
        type: "invsync_d1_ledger_primary_refused",
        correlation_id: params.correlationId,
        note: "L2 keeps Supabase as mutation authority",
      }),
    );
  }

  const started = Date.now();
  const db = getOptionalTtiDb();
  if (!db) {
    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category: "d1_error",
      primary_action: params.primary.action,
      shadow_action: "error",
      latency_ms: Date.now() - started,
      error_class: "binding_missing",
      phase: "claim",
    });
    return;
  }

  try {
    const repo = createInventorySyncLedgerRepository(db);
    const shadowRaw = await repo.claim({
      shopId: params.shopId,
      siNumber: params.siNumber,
      itemKey: params.itemKey,
      variantId: params.variantId,
      deltaQuantity: params.deltaQuantity,
      idempotencyKey: params.idempotencyKey,
    });
    const shadow = toClaimResultFromD1(shadowRaw);
    const category = classifyD1ShadowClaim(params.primary, shadow);
    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category,
      primary_action: params.primary.action,
      shadow_action: shadow.action,
      latency_ms: Date.now() - started,
      phase: "claim",
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    const message = error instanceof Error ? error.message : String(error);
    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category: isTimeoutError(message) ? "d1_timeout" : "d1_error",
      primary_action: params.primary.action,
      shadow_action: "error",
      latency_ms: Date.now() - started,
      error_class: classified.classification,
      phase: "claim",
    });
  }
}

export async function shadowFinalizeOnD1(params: {
  correlationId: string;
  shopId: string;
  idempotencyKey: string;
  outcome:
    | "succeeded"
    | "failed_retryable"
    | "failed_terminal"
    | "ambiguous";
  inventoryItemId?: string | null;
  locationId?: string | null;
  shopifyAdjustmentId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  primaryFinalizeOk: boolean;
}): Promise<void> {
  if (!isD1LedgerShadowActive()) return;

  const started = Date.now();
  const db = getOptionalTtiDb();
  if (!db) {
    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category: "d1_error",
      primary_action: params.primaryFinalizeOk ? "finalize_ok" : "finalize_fail",
      shadow_action: "error",
      latency_ms: Date.now() - started,
      error_class: "binding_missing",
      phase: "finalize",
    });
    return;
  }

  try {
    const repo = createInventorySyncLedgerRepository(db);
    const row = await repo.findByIdempotencyKey(params.idempotencyKey);
    if (!row) {
      logD1ShadowDiff({
        correlation_id: params.correlationId,
        shop_id: safeShopId(params.shopId),
        category: "missing_in_d1",
        primary_action: params.primaryFinalizeOk ? "finalize_ok" : "finalize_fail",
        shadow_action: "missing",
        latency_ms: Date.now() - started,
        phase: "finalize",
      });
      return;
    }

    if (row.status !== "processing" || !row.claim_token) {
      // Already terminal on D1 (e.g. already_synced path) — only log mismatch if primary finalized a processing path
      if (params.outcome === "succeeded" && row.status === "succeeded") {
        logD1ShadowDiff({
          correlation_id: params.correlationId,
          shop_id: safeShopId(params.shopId),
          category: "already_synced_match",
          primary_action: "finalize_ok",
          shadow_action: "already_succeeded",
          latency_ms: Date.now() - started,
          phase: "finalize",
        });
        return;
      }
      logD1ShadowDiff({
        correlation_id: params.correlationId,
        shop_id: safeShopId(params.shopId),
        category: "finalize_mismatch",
        primary_action: params.primaryFinalizeOk ? "finalize_ok" : "finalize_fail",
        shadow_action: row.status,
        latency_ms: Date.now() - started,
        phase: "finalize",
      });
      return;
    }

    const result =
      params.outcome === "succeeded"
        ? await repo.finalizeSucceeded({
            id: row.id,
            claimToken: row.claim_token,
            inventoryItemId: params.inventoryItemId,
            locationId: params.locationId,
            shopifyAdjustmentId: params.shopifyAdjustmentId,
          })
        : await repo.finalizeFailure({
            id: row.id,
            claimToken: row.claim_token,
            status: params.outcome,
            errorCode: params.errorCode || "SHADOW_FAILURE",
            errorMessage: params.errorMessage || "shadow finalize failure",
            inventoryItemId: params.inventoryItemId,
            locationId: params.locationId,
          });

    if (!result.ok) {
      logD1ShadowDiff({
        correlation_id: params.correlationId,
        shop_id: safeShopId(params.shopId),
        category:
          result.reason === "OWNER_MISMATCH"
            ? "claim_owner_mismatch"
            : "finalize_mismatch",
        primary_action: params.primaryFinalizeOk ? "finalize_ok" : "finalize_fail",
        shadow_action: result.reason || "fail",
        latency_ms: Date.now() - started,
        phase: "finalize",
      });
      return;
    }

    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category:
        params.outcome === "succeeded" ? "claimable_match" : "status_mismatch",
      primary_action: params.primaryFinalizeOk ? "finalize_ok" : "finalize_fail",
      shadow_action: params.outcome,
      latency_ms: Date.now() - started,
      phase: "finalize",
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    const message = error instanceof Error ? error.message : String(error);
    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category: isTimeoutError(message) ? "d1_timeout" : "d1_error",
      primary_action: params.primaryFinalizeOk ? "finalize_ok" : "finalize_fail",
      shadow_action: "error",
      latency_ms: Date.now() - started,
      error_class: classified.classification,
      phase: "finalize",
    });
  }
}

export async function shadowMarkAmbiguousOnD1(params: {
  correlationId: string;
  shopId: string;
  idempotencyKey: string;
  staleBefore?: string;
}): Promise<void> {
  if (!isD1LedgerShadowActive()) return;

  const started = Date.now();
  const db = getOptionalTtiDb();
  if (!db) {
    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category: "d1_error",
      primary_action: "stale_ambiguous",
      shadow_action: "error",
      latency_ms: Date.now() - started,
      error_class: "binding_missing",
      phase: "stale",
    });
    return;
  }

  try {
    const repo = createInventorySyncLedgerRepository(db);
    const row = await repo.findByIdempotencyKey(params.idempotencyKey);
    if (!row) {
      logD1ShadowDiff({
        correlation_id: params.correlationId,
        shop_id: safeShopId(params.shopId),
        category: "missing_in_d1",
        primary_action: "stale_ambiguous",
        shadow_action: "missing",
        latency_ms: Date.now() - started,
        phase: "stale",
      });
      return;
    }

    const result = await repo.markAmbiguous({
      id: row.id,
      claimToken: row.claim_token || undefined,
      staleBefore: params.staleBefore,
    });

    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category: result.ok ? "ambiguous_match" : "finalize_mismatch",
      primary_action: "stale_ambiguous",
      shadow_action: result.ok ? "ambiguous" : result.reason || "fail",
      latency_ms: Date.now() - started,
      phase: "stale",
    });
  } catch (error) {
    const classified = classifyD1Error(error);
    logD1ShadowDiff({
      correlation_id: params.correlationId,
      shop_id: safeShopId(params.shopId),
      category: "d1_error",
      primary_action: "stale_ambiguous",
      shadow_action: "error",
      latency_ms: Date.now() - started,
      error_class: classified.classification,
      phase: "stale",
    });
  }
}

/** Test helper: count D1 calls when mode=off should stay 0. */
export function d1ShadowWouldRun(): boolean {
  return isD1LedgerShadowActive();
}

export type { LedgerStatus };
