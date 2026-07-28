/** D1-only inventory sync ledger runtime. */
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createInventorySyncLedgerRepository } from "~/lib/d1/inventorySyncLedger.server";

export type LedgerStatus =
  | "pending" | "processing" | "succeeded" | "failed_retryable"
  | "failed_terminal" | "ambiguous";
export type LedgerClaimAction =
  | "claimed" | "already_synced" | "in_progress" | "manual_review"
  | "terminal" | "error";
export type LedgerRow = {
  id: string; shop_id: string; si_number: string; item_key: string;
  variant_id: string; inventory_item_id: string | null; location_id: string | null;
  delta_quantity: number; idempotency_key: string; status: LedgerStatus;
  attempt_count: number; started_at: string | null; completed_at: string | null;
  shopify_adjustment_id: string | null; error_code: string | null;
  error_message: string | null; claim_token?: string | null;
};
export type ClaimResult = { action: LedgerClaimAction; row?: LedgerRow; error_code?: string; correlationId?: string };

function repo() {
  const db = getOptionalTtiDb();
  if (!db) throw new Error("TTI_DB binding is not configured");
  return createInventorySyncLedgerRepository(db);
}

export function getInvsyncLedgerMode(): "d1" { return "d1"; }

export async function claimInventorySyncLedger(params: {
  shopId: string; siNumber: string; itemKey: string; variantId: string;
  deltaQuantity: number; idempotencyKey: string;
}): Promise<ClaimResult> {
  const result = await repo().claim(params);
  return { ...result, correlationId: crypto.randomUUID() } as ClaimResult;
}

export async function resolveStaleProcessing(row: LedgerRow): Promise<LedgerRow> {
  if (row.status !== "processing" || !row.started_at) return row;
  if (Date.now() - new Date(row.started_at).getTime() < 10 * 60 * 1000) return row;
  const result = await repo().markAmbiguous({ id: row.id, claimToken: row.claim_token ?? undefined, staleBefore: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  return (result.row ?? row) as LedgerRow;
}

export async function finalizeLedgerSuccess(params: {
  id: string; inventoryItemId?: string | null; locationId?: string | null;
  shopifyAdjustmentId?: string | null; claimToken?: string | null;
}): Promise<boolean> {
  if (!params.claimToken) return false;
  const result = await repo().finalizeSucceeded({ id: params.id, claimToken: params.claimToken, inventoryItemId: params.inventoryItemId, locationId: params.locationId, shopifyAdjustmentId: params.shopifyAdjustmentId });
  return result.ok;
}

export async function finalizeLedgerFailure(params: {
  id: string; status: "failed_retryable" | "failed_terminal" | "ambiguous";
  errorCode: string; errorMessage: string; inventoryItemId?: string | null;
  locationId?: string | null; claimToken?: string | null;
}): Promise<void> {
  if (!params.claimToken) throw new Error("Ledger finalize missing claim owner");
  const result = await repo().finalizeFailure({ id: params.id, claimToken: params.claimToken, status: params.status, errorCode: params.errorCode, errorMessage: params.errorMessage, inventoryItemId: params.inventoryItemId, locationId: params.locationId });
  if (!result.ok) throw new Error(`ledger failure finalize rejected: ${result.reason ?? "unknown"}`);
}

export async function listLedgerForShipment(params: { shopId: string; siNumber: string }) {
  return repo().listForShipment(params);
}
