/**
 * inventory_sync_ledger repository (Stage L1).
 * Claim/finalize via single-statement CAS (+ optional batch insert+select).
 * No interactive BEGIN. Never auto-reclaims stale processing.
 * Not wired into production sync paths yet.
 */

import { D1_MIGRATION_VERSION, nowIso } from "./client.server";
import { classifyD1Error } from "./errors.server";
import type {
  FinalizeResult,
  InventorySyncLedgerRow,
  LedgerClaimResult,
  LedgerStatus,
} from "./types.server";

type LedgerRaw = Record<string, unknown>;

function emptyToNull(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

export function mapLedgerRow(raw: LedgerRaw | null | undefined): InventorySyncLedgerRow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return {
    id: String(raw.id ?? ""),
    shop_id: String(raw.shop_id ?? ""),
    si_number: String(raw.si_number ?? ""),
    item_key: String(raw.item_key ?? ""),
    idempotency_key: String(raw.idempotency_key ?? ""),
    variant_id: String(raw.variant_id ?? ""),
    inventory_item_id: emptyToNull(raw.inventory_item_id),
    location_id: emptyToNull(raw.location_id),
    delta_quantity: Number(raw.delta_quantity),
    status: raw.status as LedgerStatus,
    attempt_count: Number(raw.attempt_count ?? 0),
    claim_token: emptyToNull(raw.claim_token),
    claimed_at: emptyToNull(raw.claimed_at),
    started_at: emptyToNull(raw.started_at),
    completed_at: emptyToNull(raw.completed_at),
    succeeded_at: emptyToNull(raw.succeeded_at),
    ambiguous_at: emptyToNull(raw.ambiguous_at),
    shopify_adjustment_id: emptyToNull(raw.shopify_adjustment_id),
    error_code: emptyToNull(raw.error_code),
    error_message: emptyToNull(raw.error_message),
    row_version: Number(raw.row_version ?? 1),
    migration_source: emptyToNull(raw.migration_source),
    migration_version: emptyToNull(raw.migration_version),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  };
}

/** Maps an existing row to claim action when insert/reclaim CAS did not win (Supabase RPC parity). */
function actionFromStatus(row: InventorySyncLedgerRow): LedgerClaimResult {
  switch (row.status) {
    case "succeeded":
      return { action: "already_synced", row };
    case "processing":
      return { action: "in_progress", row };
    case "ambiguous":
      return { action: "manual_review", row };
    case "failed_terminal":
      return { action: "terminal", row };
    case "pending":
    case "failed_retryable":
      // Supabase returns in_progress when reclaim UPDATE loses the race.
      return { action: "in_progress", row };
    default:
      return { action: "error", error_code: "UNKNOWN_STATUS", row };
  }
}

export type InventorySyncLedgerRepository = {
  findByIdempotencyKey: (idempotencyKey: string) => Promise<InventorySyncLedgerRow | undefined>;
  findSucceeded: (params: {
    shopId: string;
    siNumber: string;
    itemKey: string;
    idempotencyKey: string;
  }) => Promise<InventorySyncLedgerRow | undefined>;
  claim: (params: {
    shopId: string;
    siNumber: string;
    itemKey: string;
    variantId: string;
    deltaQuantity: number;
    idempotencyKey: string;
  }) => Promise<LedgerClaimResult>;
  finalizeSucceeded: (params: {
    id: string;
    claimToken: string;
    inventoryItemId?: string | null;
    locationId?: string | null;
    shopifyAdjustmentId?: string | null;
  }) => Promise<FinalizeResult>;
  finalizeFailure: (params: {
    id: string;
    claimToken: string;
    status: "failed_retryable" | "failed_terminal" | "ambiguous";
    errorCode: string;
    errorMessage: string;
    inventoryItemId?: string | null;
    locationId?: string | null;
  }) => Promise<FinalizeResult>;
  markAmbiguous: (params: {
    id: string;
    /** Owner CAS (preferred when token known). */
    claimToken?: string;
    /** Stale window: mark processing rows with claimed_at <= this ISO time. No reclaim. */
    staleBefore?: string;
    errorCode?: string;
    errorMessage?: string;
  }) => Promise<FinalizeResult>;
  listForShipment: (params: {
    shopId: string;
    siNumber: string;
  }) => Promise<InventorySyncLedgerListRow[]>;
};

/** Public list shape aligned with Supabase listLedgerForShipment / api.sync-stock GET. */
export type InventorySyncLedgerListRow = {
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
};

export function createInventorySyncLedgerRepository(
  db: D1Database,
): InventorySyncLedgerRepository {
  async function findByBusinessKey(params: {
    shopId: string;
    siNumber: string;
    itemKey: string;
    idempotencyKey: string;
  }): Promise<InventorySyncLedgerRow | undefined> {
    try {
      const result = await db
        .prepare(
          `SELECT * FROM inventory_sync_ledger
           WHERE shop_id = ? AND si_number = ? AND item_key = ? AND idempotency_key = ?`,
        )
        .bind(params.shopId, params.siNumber, params.itemKey, params.idempotencyKey)
        .first<LedgerRaw>();
      return mapLedgerRow(result ?? undefined);
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<InventorySyncLedgerRow | undefined> {
    try {
      const result = await db
        .prepare(`SELECT * FROM inventory_sync_ledger WHERE idempotency_key = ?`)
        .bind(idempotencyKey)
        .first<LedgerRaw>();
      return mapLedgerRow(result ?? undefined);
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function findSucceeded(params: {
    shopId: string;
    siNumber: string;
    itemKey: string;
    idempotencyKey: string;
  }): Promise<InventorySyncLedgerRow | undefined> {
    const row = await findByBusinessKey(params);
    if (!row || row.status !== "succeeded") return undefined;
    return row;
  }

  async function claim(params: {
    shopId: string;
    siNumber: string;
    itemKey: string;
    variantId: string;
    deltaQuantity: number;
    idempotencyKey: string;
  }): Promise<LedgerClaimResult> {
    const id = crypto.randomUUID();
    const claimToken = crypto.randomUUID();
    const ts = nowIso();

    try {
      // A+B: insert attempt + read in one batch (transactional)
      const batchResult = await db.batch([
        db
          .prepare(
            `INSERT INTO inventory_sync_ledger (
              id, shop_id, si_number, item_key, idempotency_key, variant_id,
              delta_quantity, status, attempt_count, claim_token, claimed_at, started_at,
              created_at, updated_at, migration_source, migration_version, row_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?, ?, ?, 'runtime', ?, 1)
            ON CONFLICT(shop_id, si_number, item_key, idempotency_key) DO NOTHING`,
          )
          .bind(
            id,
            params.shopId,
            params.siNumber,
            params.itemKey,
            params.idempotencyKey,
            params.variantId,
            params.deltaQuantity,
            claimToken,
            ts,
            ts,
            ts,
            ts,
            D1_MIGRATION_VERSION,
          ),
        db
          .prepare(
            `SELECT * FROM inventory_sync_ledger
             WHERE shop_id = ? AND si_number = ? AND item_key = ? AND idempotency_key = ?`,
          )
          .bind(
            params.shopId,
            params.siNumber,
            params.itemKey,
            params.idempotencyKey,
          ),
      ]);

      const insertChanges = batchResult[0]?.meta?.changes ?? 0;
      const selected = mapLedgerRow(
        (batchResult[1]?.results?.[0] as LedgerRaw | undefined) ?? undefined,
      );

      if (!selected) {
        return { action: "error", error_code: "NOT_FOUND" };
      }

      if (insertChanges === 1 && selected.claim_token === claimToken) {
        return { action: "claimed", row: selected };
      }

      if (selected.status === "succeeded") {
        return { action: "already_synced", row: selected };
      }
      if (selected.status === "processing") {
        // Owner match can only happen if our insert won; otherwise concurrent owner
        if (selected.claim_token === claimToken) {
          return { action: "claimed", row: selected };
        }
        return { action: "in_progress", row: selected };
      }
      if (selected.status === "ambiguous") {
        return { action: "manual_review", row: selected };
      }
      if (selected.status === "failed_terminal") {
        return { action: "terminal", row: selected };
      }

      if (
        selected.status === "pending" ||
        selected.status === "failed_retryable"
      ) {
        // C: CAS reclaim — never includes processing (no stale auto-reclaim)
        const reclaimTs = nowIso();
        const reclaimToken = crypto.randomUUID();
        const update = await db
          .prepare(
            `UPDATE inventory_sync_ledger
             SET status = 'processing',
                 attempt_count = attempt_count + 1,
                 claim_token = ?,
                 claimed_at = ?,
                 started_at = ?,
                 updated_at = ?,
                 completed_at = NULL,
                 succeeded_at = NULL,
                 ambiguous_at = NULL,
                 error_code = NULL,
                 error_message = NULL,
                 variant_id = ?,
                 delta_quantity = ?,
                 row_version = row_version + 1
             WHERE shop_id = ? AND si_number = ? AND item_key = ? AND idempotency_key = ?
               AND status IN ('pending', 'failed_retryable')`,
          )
          .bind(
            reclaimToken,
            reclaimTs,
            reclaimTs,
            reclaimTs,
            params.variantId,
            params.deltaQuantity,
            params.shopId,
            params.siNumber,
            params.itemKey,
            params.idempotencyKey,
          )
          .run();

        if ((update.meta.changes ?? 0) === 1) {
          const claimed = await findByBusinessKey(params);
          if (!claimed) {
            return { action: "error", error_code: "NOT_FOUND" };
          }
          return { action: "claimed", row: claimed };
        }

        const again = await findByBusinessKey(params);
        if (!again) {
          return { action: "error", error_code: "NOT_FOUND" };
        }
        return actionFromStatus(again);
      }

      return { action: "error", error_code: "UNKNOWN_STATUS", row: selected };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function finalizeCas(params: {
    id: string;
    claimToken: string;
    status: LedgerStatus;
    inventoryItemId?: string | null;
    locationId?: string | null;
    shopifyAdjustmentId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<FinalizeResult> {
    if (!params.claimToken) {
      return { ok: false, reason: "OWNER_MISMATCH" };
    }

    const ts = nowIso();
    const succeededAt = params.status === "succeeded" ? ts : null;
    const ambiguousAt = params.status === "ambiguous" ? ts : null;

    try {
      const existing = await db
        .prepare(`SELECT * FROM inventory_sync_ledger WHERE id = ?`)
        .bind(params.id)
        .first<LedgerRaw>();

      if (!existing) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      const mapped = mapLedgerRow(existing)!;
      if (mapped.status !== "processing") {
        return { ok: false, reason: "STATUS", row: mapped };
      }
      if (mapped.claim_token !== params.claimToken) {
        return { ok: false, reason: "OWNER_MISMATCH", row: mapped };
      }

      // Single CAS UPDATE — no unconditional write after read
      const update = await db
        .prepare(
          `UPDATE inventory_sync_ledger
           SET status = ?,
               completed_at = ?,
               succeeded_at = ?,
               ambiguous_at = ?,
               shopify_adjustment_id = COALESCE(?, shopify_adjustment_id),
               inventory_item_id = COALESCE(?, inventory_item_id),
               location_id = COALESCE(?, location_id),
               error_code = ?,
               error_message = ?,
               claim_token = NULL,
               updated_at = ?,
               row_version = row_version + 1
           WHERE id = ? AND status = 'processing' AND claim_token = ?`,
        )
        .bind(
          params.status,
          ts,
          succeededAt,
          ambiguousAt,
          params.shopifyAdjustmentId ?? null,
          params.inventoryItemId ?? null,
          params.locationId ?? null,
          params.errorCode ?? null,
          params.errorMessage ? params.errorMessage.slice(0, 2000) : null,
          ts,
          params.id,
          params.claimToken,
        )
        .run();

      if ((update.meta.changes ?? 0) !== 1) {
        const again = mapLedgerRow(
          (await db
            .prepare(`SELECT * FROM inventory_sync_ledger WHERE id = ?`)
            .bind(params.id)
            .first<LedgerRaw>()) ?? undefined,
        );
        if (!again) return { ok: false, reason: "NOT_FOUND" };
        if (again.status !== "processing") {
          return { ok: false, reason: "STATUS", row: again };
        }
        if (again.claim_token !== params.claimToken) {
          return { ok: false, reason: "OWNER_MISMATCH", row: again };
        }
        return { ok: false, reason: "NO_CHANGES", row: again };
      }

      const row = await db
        .prepare(`SELECT * FROM inventory_sync_ledger WHERE id = ?`)
        .bind(params.id)
        .first<LedgerRaw>();
      return { ok: true, row: mapLedgerRow(row ?? undefined) };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function finalizeSucceeded(params: {
    id: string;
    claimToken: string;
    inventoryItemId?: string | null;
    locationId?: string | null;
    shopifyAdjustmentId?: string | null;
  }): Promise<FinalizeResult> {
    return finalizeCas({
      ...params,
      status: "succeeded",
      errorCode: null,
      errorMessage: null,
    });
  }

  async function finalizeFailure(params: {
    id: string;
    claimToken: string;
    status: "failed_retryable" | "failed_terminal" | "ambiguous";
    errorCode: string;
    errorMessage: string;
    inventoryItemId?: string | null;
    locationId?: string | null;
  }): Promise<FinalizeResult> {
    return finalizeCas({
      id: params.id,
      claimToken: params.claimToken,
      status: params.status,
      inventoryItemId: params.inventoryItemId,
      locationId: params.locationId,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    });
  }

  async function markAmbiguous(params: {
    id: string;
    claimToken?: string;
    staleBefore?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<FinalizeResult> {
    const ts = nowIso();
    const errorCode = params.errorCode ?? "STALE_PROCESSING";
    const errorMessage =
      params.errorMessage ??
      "Processing exceeded stale window; Shopify outcome unknown. Manual review required.";

    try {
      if (params.claimToken) {
        return finalizeCas({
          id: params.id,
          claimToken: params.claimToken,
          status: "ambiguous",
          errorCode,
          errorMessage,
        });
      }

      if (!params.staleBefore) {
        return { ok: false, reason: "OWNER_MISMATCH" };
      }

      // Stale mark: CAS on status+claimed_at only. Does NOT reclaim for retry.
      const update = await db
        .prepare(
          `UPDATE inventory_sync_ledger
           SET status = 'ambiguous',
               error_code = ?,
               error_message = ?,
               claim_token = NULL,
               ambiguous_at = ?,
               completed_at = ?,
               updated_at = ?,
               row_version = row_version + 1
           WHERE id = ? AND status = 'processing' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
        )
        .bind(
          errorCode,
          errorMessage.slice(0, 2000),
          ts,
          ts,
          ts,
          params.id,
          params.staleBefore,
        )
        .run();

      if ((update.meta.changes ?? 0) !== 1) {
        const again = mapLedgerRow(
          (await db
            .prepare(`SELECT * FROM inventory_sync_ledger WHERE id = ?`)
            .bind(params.id)
            .first<LedgerRaw>()) ?? undefined,
        );
        if (!again) return { ok: false, reason: "NOT_FOUND" };
        if (again.status !== "processing") {
          return { ok: false, reason: "STATUS", row: again };
        }
        return { ok: false, reason: "NO_CHANGES", row: again };
      }

      const row = mapLedgerRow(
        (await db
          .prepare(`SELECT * FROM inventory_sync_ledger WHERE id = ?`)
          .bind(params.id)
          .first<LedgerRaw>()) ?? undefined,
      );
      return { ok: true, row };
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  async function listForShipment(params: {
    shopId: string;
    siNumber: string;
  }): Promise<InventorySyncLedgerListRow[]> {
    try {
      const result = await db
        .prepare(
          `SELECT shop_id, si_number, item_key, variant_id, delta_quantity, status,
                  attempt_count, started_at, completed_at, shopify_adjustment_id,
                  error_code, error_message, idempotency_key
           FROM inventory_sync_ledger
           WHERE shop_id = ? AND si_number = ?
           ORDER BY created_at ASC`,
        )
        .bind(params.shopId, params.siNumber)
        .all<LedgerRaw>();

      return (result.results ?? []).map((raw) => ({
        shop_id: String(raw.shop_id ?? ""),
        si_number: String(raw.si_number ?? ""),
        item_key: String(raw.item_key ?? ""),
        variant_id: String(raw.variant_id ?? ""),
        delta_quantity: Number(raw.delta_quantity),
        status: raw.status as LedgerStatus,
        attempt_count: Number(raw.attempt_count ?? 0),
        started_at: emptyToNull(raw.started_at),
        completed_at: emptyToNull(raw.completed_at),
        shopify_adjustment_id: emptyToNull(raw.shopify_adjustment_id),
        error_code: emptyToNull(raw.error_code),
        error_message: emptyToNull(raw.error_message),
        idempotency_key: String(raw.idempotency_key ?? ""),
      }));
    } catch (error) {
      throw classifyD1Error(error);
    }
  }

  return {
    findByIdempotencyKey,
    findSucceeded,
    claim,
    finalizeSucceeded,
    finalizeFailure,
    markAmbiguous,
    listForShipment,
  };
}
