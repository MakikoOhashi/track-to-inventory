/** Shared D1 row types (Stage L1). Timestamps are ISO8601 TEXT. */

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

export type InventorySyncLedgerRow = {
  id: string;
  shop_id: string;
  si_number: string;
  item_key: string;
  idempotency_key: string;
  variant_id: string;
  inventory_item_id: string | null;
  location_id: string | null;
  delta_quantity: number;
  status: LedgerStatus;
  attempt_count: number;
  claim_token: string | null;
  claimed_at: string | null;
  /** mutation_started_at */
  started_at: string | null;
  /** mutation_completed_at */
  completed_at: string | null;
  succeeded_at: string | null;
  ambiguous_at: string | null;
  shopify_adjustment_id: string | null;
  error_code: string | null;
  error_message: string | null;
  row_version: number;
  migration_source: string | null;
  migration_version: string | null;
  created_at: string;
  updated_at: string;
};

export type LedgerClaimResult = {
  action: LedgerClaimAction;
  row?: InventorySyncLedgerRow;
  error_code?: string;
};

export type FinalizeResult = {
  ok: boolean;
  reason?: "NOT_FOUND" | "STATUS" | "OWNER_MISMATCH" | "NO_CHANGES";
  row?: InventorySyncLedgerRow;
};

/** Matches Redis StoredSessionPayload (session.toPropertyArray). */
export type ShopifySessionPayload = {
  entries: [string, string | number | boolean][];
  shop: string;
  expiresAt?: number;
};

export type ShopifySessionRow = {
  id: string;
  shop: string;
  payload_json: string;
  is_online: number;
  expires_at: string | null;
  migration_source: string | null;
  migration_version: string | null;
  created_at: string;
  updated_at: string;
};
