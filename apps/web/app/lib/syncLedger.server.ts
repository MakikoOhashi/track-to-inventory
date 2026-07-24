import { createSupabaseAdminClient } from "~/lib/supabase.server";

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
};

export type ClaimResult = {
  action: LedgerClaimAction;
  row?: LedgerRow;
  error_code?: string;
};

/** Processing older than this is treated as stale → ambiguous (no Shopify retry). */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;

export async function claimInventorySyncLedger(params: {
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

/**
 * If a row is stuck in processing past the stale window, mark ambiguous.
 * Does not call Shopify and does not reopen for automatic retry.
 */
export async function resolveStaleProcessing(
  row: LedgerRow,
): Promise<LedgerRow> {
  if (row.status !== "processing" || !row.started_at) return row;

  const age = Date.now() - new Date(row.started_at).getTime();
  if (age < STALE_PROCESSING_MS) return row;

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

  return (data as LedgerRow) || row;
}

export async function finalizeLedgerSuccess(params: {
  id: string;
  inventoryItemId?: string | null;
  locationId?: string | null;
  shopifyAdjustmentId?: string | null;
}): Promise<boolean> {
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
  return Boolean(data?.id);
}

export async function finalizeLedgerFailure(params: {
  id: string;
  status: "failed_retryable" | "failed_terminal" | "ambiguous";
  errorCode: string;
  errorMessage: string;
  inventoryItemId?: string | null;
  locationId?: string | null;
}): Promise<void> {
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
    throw new Error(`ledger failure finalize failed: ${error.message}`);
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
