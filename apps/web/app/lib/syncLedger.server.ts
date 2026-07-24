import { createSupabaseAdminClient } from "~/lib/supabase.server";
import {
  shadowClaimOnD1,
  shadowFinalizeOnD1,
  shadowMarkAmbiguousOnD1,
} from "~/lib/d1LedgerShadow.server";
import {
  claimInventorySyncLedgerRedis,
  classifyShadowDiff,
  finalizeLedgerRedis,
  listLedgerForShipmentRedis,
  logShadowDiff,
  markStaleProcessingRedis,
  simulateClaimInventorySyncLedgerRedis,
} from "~/lib/syncLedgerRedis.server";

export type LedgerStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "ambiguous";

export type LedgerClaimAction =
  | "claimed"
  | "already_synced"
  | "in_progress"
  | "manual_review"
  | "terminal"
  | "error";

export type LedgerRow = {
  id: string;
  shop_id: string;
  si_number: string;
  item_key: string;
  variant_id: string;
  inventory_item_id: string | null;
  location_id: string | null;
  delta_quantity: number;
  idempotency_key: string;
  status: LedgerStatus;
  attempt_count: number;
  started_at: string | null;
  completed_at: string | null;
  shopify_adjustment_id: string | null;
  error_code: string | null;
  error_message: string | null;
  /** Redis claim owner token; absent on Supabase-only rows */
  claim_token?: string | null;
};

export type ClaimResult = {
  action: LedgerClaimAction;
  row?: LedgerRow;
  error_code?: string;
  /** Correlates D1 shadow logs for this claim attempt */
  correlationId?: string;
};

/** Processing older than this is treated as stale → ambiguous (no Shopify retry). */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;

/**
 * supabase — Stage I path (default / rollback authority when mirrored)
 * shadow  — Supabase is execution authority; Redis claim simulated + logged
 * redis   — Redis is execution authority; finalize mirrored to Supabase
 */
export type InvsyncLedgerMode = "supabase" | "shadow" | "redis";

export function getInvsyncLedgerMode(): InvsyncLedgerMode {
  const raw = (process.env.INVSYNC_LEDGER_MODE || "supabase").trim().toLowerCase();
  if (raw === "shadow" || raw === "redis" || raw === "supabase") return raw;
  return "supabase";
}

async function claimSupabase(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  variantId: string;
  deltaQuantity: number;
  idempotencyKey: string;
}): Promise<ClaimResult> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("claim_inventory_sync_ledger", {
    p_shop_id: params.shopId,
    p_si_number: params.siNumber,
    p_item_key: params.itemKey,
    p_variant_id: params.variantId,
    p_delta_quantity: params.deltaQuantity,
    p_idempotency_key: params.idempotencyKey,
  });

  if (error) {
    throw new Error(`claim_inventory_sync_ledger failed: ${error.message}`);
  }

  return data as ClaimResult;
}

async function mirrorFinalStateToSupabase(params: {
  id: string;
  status: LedgerStatus;
  inventoryItemId?: string | null;
  locationId?: string | null;
  shopifyAdjustmentId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase
      .from("inventory_sync_ledger")
      .update({
        status: params.status,
        inventory_item_id: params.inventoryItemId ?? null,
        location_id: params.locationId ?? null,
        shopify_adjustment_id: params.shopifyAdjustmentId ?? null,
        error_code: params.errorCode ?? null,
        error_message: params.errorMessage
          ? params.errorMessage.slice(0, 2000)
          : null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.id);

    if (error) {
      console.log(
        JSON.stringify({
          type: "invsync_supabase_mirror_failed",
          id: params.id,
          status: params.status,
          error: error.message,
        }),
      );
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({
        type: "invsync_supabase_mirror_failed",
        id: params.id,
        status: params.status,
        error: message,
      }),
    );
    return { ok: false, error: message };
  }
}

/**
 * Best-effort upsert of a Redis-claimed processing row into Supabase
 * so rollback mirrors have a row id to update.
 */
async function mirrorClaimToSupabase(row: LedgerRow): Promise<void> {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.from("inventory_sync_ledger").upsert(
      {
        id: row.id,
        shop_id: row.shop_id,
        si_number: row.si_number,
        item_key: row.item_key,
        variant_id: row.variant_id,
        delta_quantity: row.delta_quantity,
        idempotency_key: row.idempotency_key,
        status: "processing",
        attempt_count: row.attempt_count,
        started_at: row.started_at,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shop_id,si_number,item_key,idempotency_key" },
    );
    if (error) {
      console.log(
        JSON.stringify({
          type: "invsync_supabase_claim_mirror_failed",
          id: row.id,
          error: error.message,
        }),
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "invsync_supabase_claim_mirror_failed",
        id: row.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function claimInventorySyncLedger(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  variantId: string;
  deltaQuantity: number;
  idempotencyKey: string;
}): Promise<ClaimResult> {
  const mode = getInvsyncLedgerMode();
  const correlationId = crypto.randomUUID();

  if (mode === "redis") {
    const result = await claimInventorySyncLedgerRedis(params);
    if (result.action === "claimed" && result.row) {
      // Mirror must not gate Shopify mutation
      void mirrorClaimToSupabase(result.row);
    }
    result.correlationId = correlationId;
    // D1 shadow is independent of Redis authority mode
    await shadowClaimOnD1({
      correlationId,
      primary: result,
      ...params,
    });
    return result;
  }

  const primary = await claimSupabase(params);
  primary.correlationId = correlationId;

  if (mode === "shadow") {
    try {
      const shadow = await simulateClaimInventorySyncLedgerRedis({
        shopId: params.shopId,
        siNumber: params.siNumber,
        itemKey: params.itemKey,
        idempotencyKey: params.idempotencyKey,
      });
      const classification = classifyShadowDiff(primary, shadow);
      logShadowDiff({
        shopId: params.shopId,
        siNumber: params.siNumber,
        itemKey: params.itemKey,
        idempotencyKeyPrefix: params.idempotencyKey.slice(0, 12),
        primaryAction: primary.action,
        shadowAction: shadow.action,
        classification,
      });

      // Keep Redis warm for already-synced paths: if primary claimed, also claim Redis
      // so finalize can dual-write without inventing a separate shadow write path.
      if (primary.action === "claimed") {
        try {
          const redisClaim = await claimInventorySyncLedgerRedis(params);
          if (redisClaim.action === "claimed" && redisClaim.row) {
            // Attach Redis claim_token onto primary row for dual finalize
            primary.row = {
              ...primary.row!,
              claim_token: redisClaim.row.claim_token,
              // keep Supabase id as ledger id for API stability
            };
          } else if (redisClaim.action !== "claimed") {
            logShadowDiff({
              shopId: params.shopId,
              siNumber: params.siNumber,
              itemKey: params.itemKey,
              idempotencyKeyPrefix: params.idempotencyKey.slice(0, 12),
              primaryAction: primary.action,
              shadowAction: redisClaim.action,
              classification: "action_mismatch",
            });
          }
        } catch (error) {
          console.log(
            JSON.stringify({
              type: "invsync_shadow_redis_claim_error",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          type: "invsync_shadow_error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      // Shadow failures never block or authorize mutation
    }
  }

  // D1 shadow (Stage L2): after primary decision; never alters primary / mutation auth
  await shadowClaimOnD1({
    correlationId,
    primary,
    ...params,
  });

  return primary;
}

/**
 * If a row is stuck in processing past the stale window, mark ambiguous.
 * Does not call Shopify and does not reopen for automatic retry.
 */
export async function resolveStaleProcessing(
  row: LedgerRow,
  opts?: { correlationId?: string },
): Promise<LedgerRow> {
  if (row.status !== "processing" || !row.started_at) return row;

  const age = Date.now() - new Date(row.started_at).getTime();
  if (age < STALE_PROCESSING_MS) return row;

  const mode = getInvsyncLedgerMode();
  if (mode === "redis") {
    const updated = await markStaleProcessingRedis(row);
    await shadowMarkAmbiguousOnD1({
      correlationId: opts?.correlationId || crypto.randomUUID(),
      shopId: row.shop_id,
      idempotencyKey: row.idempotency_key,
      staleBefore: new Date(Date.now() - STALE_PROCESSING_MS).toISOString(),
    });
    return updated;
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("inventory_sync_ledger")
    .update({
      status: "ambiguous",
      error_code: "STALE_PROCESSING",
      error_message:
        "Processing exceeded stale window; Shopify outcome unknown. Manual review required.",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "processing")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`stale processing update failed: ${error.message}`);
  }

  const updated = (data as LedgerRow) || row;

  if (mode === "shadow" && row.claim_token) {
    try {
      await markStaleProcessingRedis({ ...row, claim_token: row.claim_token });
    } catch {
      // ignore shadow stale mirror errors
    }
  }

  await shadowMarkAmbiguousOnD1({
    correlationId: opts?.correlationId || crypto.randomUUID(),
    shopId: row.shop_id,
    idempotencyKey: row.idempotency_key,
    staleBefore: new Date(Date.now() - STALE_PROCESSING_MS).toISOString(),
  });

  return updated;
}

export async function finalizeLedgerSuccess(params: {
  id: string;
  inventoryItemId?: string | null;
  locationId?: string | null;
  shopifyAdjustmentId?: string | null;
  /** Required for Redis/shadow dual finalize */
  claimToken?: string | null;
  shopId?: string;
  siNumber?: string;
  itemKey?: string;
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<boolean> {
  const mode = getInvsyncLedgerMode();
  const correlationId = params.correlationId || crypto.randomUUID();

  if (mode === "redis") {
    if (
      !params.claimToken ||
      !params.shopId ||
      !params.siNumber ||
      !params.itemKey ||
      !params.idempotencyKey
    ) {
      return false;
    }
    const result = await finalizeLedgerRedis({
      shopId: params.shopId,
      siNumber: params.siNumber,
      itemKey: params.itemKey,
      idempotencyKey: params.idempotencyKey,
      claimToken: params.claimToken,
      status: "succeeded",
      inventoryItemId: params.inventoryItemId,
      locationId: params.locationId,
      shopifyAdjustmentId: params.shopifyAdjustmentId,
    });
    if (result.ok) {
      // Mirror failure must not undo Shopify success / Redis succeeded
      void mirrorFinalStateToSupabase({
        id: params.id,
        status: "succeeded",
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        shopifyAdjustmentId: params.shopifyAdjustmentId,
      });
    }
    if (params.shopId && params.idempotencyKey) {
      await shadowFinalizeOnD1({
        correlationId,
        shopId: params.shopId,
        idempotencyKey: params.idempotencyKey,
        outcome: "succeeded",
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        shopifyAdjustmentId: params.shopifyAdjustmentId,
        primaryFinalizeOk: result.ok,
      });
    }
    return result.ok;
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("inventory_sync_ledger")
    .update({
      status: "succeeded",
      inventory_item_id: params.inventoryItemId ?? null,
      location_id: params.locationId ?? null,
      shopify_adjustment_id: params.shopifyAdjustmentId ?? null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
    })
    .eq("id", params.id)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`ledger success finalize failed: ${error.message}`);
  }

  const ok = Boolean(data?.id);

  if (
    ok &&
    mode === "shadow" &&
    params.claimToken &&
    params.shopId &&
    params.siNumber &&
    params.itemKey &&
    params.idempotencyKey
  ) {
    try {
      await finalizeLedgerRedis({
        shopId: params.shopId,
        siNumber: params.siNumber,
        itemKey: params.itemKey,
        idempotencyKey: params.idempotencyKey,
        claimToken: params.claimToken,
        status: "succeeded",
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        shopifyAdjustmentId: params.shopifyAdjustmentId,
      });
    } catch (error) {
      console.log(
        JSON.stringify({
          type: "invsync_shadow_finalize_error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  if (params.shopId && params.idempotencyKey) {
    await shadowFinalizeOnD1({
      correlationId,
      shopId: params.shopId,
      idempotencyKey: params.idempotencyKey,
      outcome: "succeeded",
      inventoryItemId: params.inventoryItemId,
      locationId: params.locationId,
      shopifyAdjustmentId: params.shopifyAdjustmentId,
      primaryFinalizeOk: ok,
    });
  }

  return ok;
}

export async function finalizeLedgerFailure(params: {
  id: string;
  status: "failed_retryable" | "failed_terminal" | "ambiguous";
  errorCode: string;
  errorMessage: string;
  inventoryItemId?: string | null;
  locationId?: string | null;
  claimToken?: string | null;
  shopId?: string;
  siNumber?: string;
  itemKey?: string;
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<void> {
  const mode = getInvsyncLedgerMode();
  const correlationId = params.correlationId || crypto.randomUUID();
  let primaryOk = true;

  if (mode === "redis") {
    if (
      !params.claimToken ||
      !params.shopId ||
      !params.siNumber ||
      !params.itemKey ||
      !params.idempotencyKey
    ) {
      throw new Error("Redis finalize missing claim owner fields");
    }
    const result = await finalizeLedgerRedis({
      shopId: params.shopId,
      siNumber: params.siNumber,
      itemKey: params.itemKey,
      idempotencyKey: params.idempotencyKey,
      claimToken: params.claimToken,
      status: params.status,
      inventoryItemId: params.inventoryItemId,
      locationId: params.locationId,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    });
    if (!result.ok) {
      throw new Error(`Redis ledger failure finalize rejected: ${result.reason}`);
    }
    void mirrorFinalStateToSupabase({
      id: params.id,
      status: params.status,
      inventoryItemId: params.inventoryItemId,
      locationId: params.locationId,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    });
    await shadowFinalizeOnD1({
      correlationId,
      shopId: params.shopId,
      idempotencyKey: params.idempotencyKey,
      outcome: params.status,
      inventoryItemId: params.inventoryItemId,
      locationId: params.locationId,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      primaryFinalizeOk: true,
    });
    return;
  }

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("inventory_sync_ledger")
    .update({
      status: params.status,
      error_code: params.errorCode,
      error_message: params.errorMessage.slice(0, 2000),
      inventory_item_id: params.inventoryItemId ?? null,
      location_id: params.locationId ?? null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("status", "processing");

  if (error) {
    if (params.shopId && params.idempotencyKey) {
      await shadowFinalizeOnD1({
        correlationId,
        shopId: params.shopId,
        idempotencyKey: params.idempotencyKey,
        outcome: params.status,
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
        primaryFinalizeOk: false,
      });
    }
    throw new Error(`ledger failure finalize failed: ${error.message}`);
  }

  if (
    mode === "shadow" &&
    params.claimToken &&
    params.shopId &&
    params.siNumber &&
    params.itemKey &&
    params.idempotencyKey
  ) {
    try {
      await finalizeLedgerRedis({
        shopId: params.shopId,
        siNumber: params.siNumber,
        itemKey: params.itemKey,
        idempotencyKey: params.idempotencyKey,
        claimToken: params.claimToken,
        status: params.status,
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
      });
    } catch {
      // shadow finalize errors are non-fatal
    }
  }

  if (params.shopId && params.idempotencyKey) {
    await shadowFinalizeOnD1({
      correlationId,
      shopId: params.shopId,
      idempotencyKey: params.idempotencyKey,
      outcome: params.status,
      inventoryItemId: params.inventoryItemId,
      locationId: params.locationId,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      primaryFinalizeOk: primaryOk,
    });
  }
}

/** Read-only ledger rows for a shop + SI (investigation). */
export async function listLedgerForShipment(params: {
  shopId: string;
  siNumber: string;
}): Promise<
  Array<{
    shop_id: string;
    si_number: string;
    item_key: string;
    variant_id: string;
    delta_quantity: number;
    status: LedgerStatus;
    attempt_count: number;
    started_at: string | null;
    completed_at: string | null;
    shopify_adjustment_id: string | null;
    error_code: string | null;
    error_message: string | null;
    idempotency_key: string;
  }>
> {
  const mode = getInvsyncLedgerMode();
  if (mode === "redis") {
    const rows = await listLedgerForShipmentRedis(params);
    return rows.map((r) => ({
      shop_id: r.shop_id,
      si_number: r.si_number,
      item_key: r.item_key,
      variant_id: r.variant_id,
      delta_quantity: r.delta_quantity,
      status: r.status,
      attempt_count: r.attempt_count,
      started_at: r.started_at,
      completed_at: r.completed_at,
      shopify_adjustment_id: r.shopify_adjustment_id,
      error_code: r.error_code,
      error_message: r.error_message,
      idempotency_key: r.idempotency_key,
    }));
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("inventory_sync_ledger")
    .select(
      "shop_id, si_number, item_key, variant_id, delta_quantity, status, attempt_count, started_at, completed_at, shopify_adjustment_id, error_code, error_message, idempotency_key",
    )
    .eq("shop_id", params.shopId)
    .eq("si_number", params.siNumber)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`ledger list failed: ${error.message}`);
  }
  return data || [];
}
