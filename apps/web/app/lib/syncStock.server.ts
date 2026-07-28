import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createShipmentsRepository } from "~/lib/d1/shipments.server";
import {
  buildSyncIdempotencyKey,
  ensureSyncItemId,
  normalizeDeltaQuantity,
  type ShipmentLineItem,
} from "~/lib/syncItemIdentity.server";
import {
  claimInventorySyncLedger,
  finalizeLedgerFailure,
  finalizeLedgerSuccess,
  resolveStaleProcessing,
  type LedgerRow,
} from "~/lib/syncLedger.server";

export type SyncStockItemInput = {
  sync_item_id?: string;
  variant_id?: string;
  quantity?: unknown;
};

export type SyncItemStatus =
  | "synced"
  | "already-synced"
  | "in-progress"
  | "retryable-failure"
  | "terminal-failure"
  | "manual-review-required";

export type SyncStockResult = {
  variant_id: string;
  item_key?: string;
  sync_status: SyncItemStatus;
  product_title?: string;
  before_quantity?: number;
  delta?: number;
  after_quantity?: number;
  tracking_enabled?: boolean;
  response?: unknown;
  errors?: Array<{ field?: string[] | null; message: string; code?: string }>;
  strategy_used?: string;
  error?: string;
  errorType?: string;
  failedStep?: string;
  graphqlErrors?: unknown;
  ledger_id?: string;
  shopify_adjustment_id?: string | null;
};

export class SyncStockError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SyncStockError";
    this.code = code;
    this.status = status;
  }
}

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type UserError = { field?: string[] | null; message: string; code?: string };

function hasErrors(data: unknown): {
  hasGraphQLErrors: boolean;
  hasUserErrors: boolean;
  userErrors: UserError[];
} {
  const payload = data as { errors?: unknown } | null;
  const hasGraphQLErrors = Array.isArray(payload?.errors) && payload.errors.length > 0;

  function findUserErrors(obj: unknown): UserError[] {
    const userErrors: UserError[] = [];
    if (!obj || typeof obj !== "object") return userErrors;

    const record = obj as Record<string, unknown>;
    if (Array.isArray(record.userErrors)) {
      userErrors.push(...(record.userErrors as UserError[]));
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        userErrors.push(...findUserErrors(value));
      }
    }
    return userErrors;
  }

  const userErrors = findUserErrors(data);
  return { hasGraphQLErrors, hasUserErrors: userErrors.length > 0, userErrors };
}

async function adminGraphql(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any; transportError?: string }> {
  try {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

function classifyUserErrors(
  userErrors: UserError[],
): "failed_retryable" | "failed_terminal" {
  const text = userErrors
    .map((e) => `${e.code || ""} ${e.message || ""}`.toLowerCase())
    .join(" | ");

  if (
    /throttl|rate.?limit|timeout|temporar|unavailable|try again|concurrent|conflict/.test(
      text,
    )
  ) {
    return "failed_retryable";
  }

  if (
    /not found|does not exist|invalid|denied|forbidden|access|parameter.?mismatch/.test(
      text,
    )
  ) {
    return "failed_terminal";
  }

  return "failed_retryable";
}

function resultFromLedger(
  row: LedgerRow,
  syncStatus: SyncItemStatus,
  extra: Partial<SyncStockResult> = {},
): SyncStockResult {
  return {
    variant_id: row.variant_id,
    item_key: row.item_key,
    sync_status: syncStatus,
    delta: Number(row.delta_quantity),
    ledger_id: row.id,
    shopify_adjustment_id: row.shopify_adjustment_id,
    error: row.error_message || undefined,
    errorType: row.error_code || undefined,
    ...extra,
  };
}

async function loadShipmentForSync(params: {
  shop: string;
  siNumber: string;
}): Promise<{ items: ShipmentLineItem[] }> {
  const db = getOptionalTtiDb();
  if (!db) throw new SyncStockError("DB_ERROR", "データベースエラー", 500);
  const repo = createShipmentsRepository(db);
  const data = await repo.getByShopAndSi(params.shop, params.siNumber);
  if (!data) {
    throw new SyncStockError("NOT_FOUND", "出荷データが見つかりません", 404);
  }

  const items = Array.isArray(data.items) ? ([...data.items] as ShipmentLineItem[]) : [];

  // Prefer reusing succeeded ledger item_keys when sync_item_id is missing,
  // so a later ID backfill cannot create a new idempotency key and re-adjust stock.
  const succeededRows = (await import("~/lib/syncLedger.server")).listLedgerForShipment({ shopId: params.shop, siNumber: params.siNumber });
  const succeeded = (await succeededRows).filter((row) => row.status === "succeeded");

  const usedKeys = new Set(
    items
      .map((item) => (typeof item.sync_item_id === "string" ? item.sync_item_id.trim() : ""))
      .filter(Boolean),
  );
  const reusable = succeeded.filter(
    (row) => row.item_key && !usedKeys.has(row.item_key),
  );

  let mutated = false;
  for (const item of items) {
    const existing =
      typeof item.sync_item_id === "string" && item.sync_item_id.trim()
        ? item.sync_item_id.trim()
        : "";
    if (existing) continue;

    const delta = normalizeDeltaQuantity(item.quantity);
    const matchIndex = reusable.findIndex(
      (row) =>
        row.variant_id === item.variant_id &&
        delta !== null &&
        Number(row.delta_quantity) === delta,
    );
    if (matchIndex >= 0) {
      const [matched] = reusable.splice(matchIndex, 1);
      item.sync_item_id = matched.item_key;
      usedKeys.add(matched.item_key);
      mutated = true;
      continue;
    }

    ensureSyncItemId(item);
    mutated = true;
  }

  if (mutated) {
    try {
      await repo.update(params.shop, params.siNumber, { items });
    } catch {
      throw new SyncStockError("DB_ERROR", "sync_item_idの保存に失敗しました", 500);
    }
  }

  return { items };
}

/**
 * Confirm requested sync lines belong to the shipment (by sync_item_id + variant).
 */
function matchRequestedItems(params: {
  shipmentItems: ShipmentLineItem[];
  requested: SyncStockItemInput[];
}): Array<{ itemKey: string; variantId: string; quantity: number; shipmentItem: ShipmentLineItem }> {
  const byKey = new Map<string, ShipmentLineItem>();
  for (const item of params.shipmentItems) {
    if (typeof item.sync_item_id === "string" && item.sync_item_id) {
      byKey.set(item.sync_item_id, item);
    }
  }

  const matched: Array<{
    itemKey: string;
    variantId: string;
    quantity: number;
    shipmentItem: ShipmentLineItem;
  }> = [];

  for (const req of params.requested) {
    if (!req?.variant_id || typeof req.variant_id !== "string") {
      throw new SyncStockError("INVALID_ITEM", "variant_idが必要です", 400);
    }

    let shipmentItem: ShipmentLineItem | undefined;
    if (typeof req.sync_item_id === "string" && req.sync_item_id.trim()) {
      shipmentItem = byKey.get(req.sync_item_id.trim());
      if (!shipmentItem || shipmentItem.variant_id !== req.variant_id) {
        throw new SyncStockError("FORBIDDEN_ITEM", "同期対象の商品が不正です", 403);
      }
    } else {
      // Fallback: unique variant match only (legacy clients without sync_item_id)
      const candidates = params.shipmentItems.filter(
        (item) => item.variant_id === req.variant_id,
      );
      if (candidates.length !== 1) {
        throw new SyncStockError("FORBIDDEN_ITEM", "同期対象の商品が不正です", 403);
      }
      shipmentItem = candidates[0];
    }

    const quantity = normalizeDeltaQuantity(
      req.quantity !== undefined ? req.quantity : shipmentItem.quantity,
    );
    if (quantity === null) {
      throw new SyncStockError("INVALID_ITEM", "quantityが数値ではありません", 400);
    }

    matched.push({
      itemKey: ensureSyncItemId(shipmentItem),
      variantId: req.variant_id,
      quantity,
      shipmentItem,
    });
  }

  return matched;
}

async function adjustWithIdempotency(params: {
  admin: AdminClient;
  inventoryItemId: string;
  locationId: string;
  delta: number;
  idempotencyKey: string;
  referenceDocumentUri: string;
  currentQuantity: number;
}): Promise<{
  outcome: "success" | "user_error" | "graphql_error" | "ambiguous" | "pre_request_failure";
  strategy?: string;
  adjustmentId?: string | null;
  group?: unknown;
  userErrors?: UserError[];
  graphqlErrors?: unknown;
  errorMessage?: string;
}> {
  const { admin, inventoryItemId, locationId, delta, idempotencyKey, referenceDocumentUri, currentQuantity } =
    params;

  const adjustMutation = `
    mutation($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup {
          id
          createdAt
          reason
          referenceDocumentUri
          changes { name delta }
        }
        userErrors { field message code }
      }
    }
  `;

  const adjustResult = await adminGraphql(admin, adjustMutation, {
    idempotencyKey,
    input: {
      reason: "correction",
      name: "available",
      referenceDocumentUri,
      changes: [
        {
          delta,
          inventoryItemId,
          locationId,
        },
      ],
    },
  });

  if (adjustResult.transportError) {
    // Request may or may not have reached Shopify
    return {
      outcome: "ambiguous",
      errorMessage: adjustResult.transportError,
    };
  }

  const adjustCheck = hasErrors(adjustResult.data);
  if (!adjustResult.ok || adjustCheck.hasGraphQLErrors) {
    // HTTP/GraphQL transport-level failure after send → treat as ambiguous
    if (!adjustResult.ok || adjustResult.status === 0) {
      return {
        outcome: "ambiguous",
        graphqlErrors: adjustResult.data?.errors,
        errorMessage: "Shopify GraphQL request failed with unknown outcome",
      };
    }
    return {
      outcome: "graphql_error",
      graphqlErrors: adjustResult.data?.errors,
      errorMessage: "GraphQL errors from inventoryAdjustQuantities",
    };
  }

  if (!adjustCheck.hasUserErrors) {
    const group = adjustResult.data?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup;
    return {
      outcome: "success",
      strategy: "inventoryAdjustQuantities",
      adjustmentId: group?.id || null,
      group,
    };
  }

  // Clear userErrors from Shopify — safe to classify (not ambiguous)
  const userErrors = adjustCheck.userErrors;
  const concurrent = userErrors.some(
    (e) => (e.code || "").toUpperCase() === "IDEMPOTENCY_CONCURRENT_REQUEST",
  );
  if (concurrent) {
    return {
      outcome: "user_error",
      userErrors,
      errorMessage: "Idempotent request already in progress",
      strategy: "idempotency-concurrent",
    };
  }

  // Fallback set with same idempotency key (official @idempotent on set as well)
  const newQuantity = Math.max(0, currentQuantity + delta);
  const setMutation = `
    mutation($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup {
          id
          reason
          referenceDocumentUri
          changes {
            delta
            quantityAfterChange
            item { id }
            location { id }
          }
        }
        userErrors { field message code }
      }
    }
  `;

  const setResult = await adminGraphql(admin, setMutation, {
    idempotencyKey,
    input: {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      referenceDocumentUri,
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity: newQuantity,
        },
      ],
    },
  });

  if (setResult.transportError || !setResult.ok) {
    return {
      outcome: "ambiguous",
      errorMessage:
        setResult.transportError ||
        "inventorySetQuantities request failed with unknown outcome",
      userErrors,
    };
  }

  const setCheck = hasErrors(setResult.data);
  if (setCheck.hasGraphQLErrors) {
    return {
      outcome: "graphql_error",
      graphqlErrors: setResult.data?.errors,
      userErrors,
      errorMessage: "GraphQL errors from inventorySetQuantities",
    };
  }

  if (!setCheck.hasUserErrors) {
    const group = setResult.data?.data?.inventorySetQuantities?.inventoryAdjustmentGroup;
    return {
      outcome: "success",
      strategy: "inventorySetQuantities",
      adjustmentId: group?.id || null,
      group,
    };
  }

  return {
    outcome: "user_error",
    userErrors: setCheck.userErrors.length ? setCheck.userErrors : userErrors,
    errorMessage: "Inventory mutation userErrors",
  };
}

/**
 * Re-run-safe DELTA sync (Stage I).
 * - Ledger claim is atomic; succeeded items never call Shopify again
 * - Shopify @idempotent (API 2026-01+) as secondary guard
 * - ambiguous never auto-retries
 */
export async function syncShipmentStock(params: {
  admin: AdminClient;
  shop: string;
  siNumber: string;
  items: SyncStockItemInput[];
}): Promise<{ results: SyncStockResult[] }> {
  const { admin, shop, siNumber, items } = params;

  if (!siNumber || typeof siNumber !== "string") {
    throw new SyncStockError("SI_REQUIRED", "SI番号が必要です", 400);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new SyncStockError("NO_ITEMS", "同期する商品がありません", 400);
  }

  const { items: shipmentItems } = await loadShipmentForSync({ shop, siNumber });
  const matched = matchRequestedItems({ shipmentItems, requested: items });

  const locationsQuery = `
    query {
      locations(first: 1) {
        edges {
          node {
            id
            name
            isActive
            isPrimary
          }
        }
      }
    }
  `;

  const locationResult = await adminGraphql(admin, locationsQuery);
  if (
    locationResult.transportError ||
    !locationResult.ok ||
    !locationResult.data?.data?.locations?.edges?.length
  ) {
    throw new SyncStockError("NO_LOCATION", "ロケーション情報を取得できませんでした", 400);
  }

  const locations = locationResult.data.data.locations.edges;
  const primaryLocation =
    locations.find((loc: { node: { isPrimary?: boolean } }) => loc.node.isPrimary) ||
    locations[0];
  const locationId = primaryLocation.node.id as string;
  const locationName = primaryLocation.node.name as string | undefined;

  const results: SyncStockResult[] = [];

  for (const line of matched) {
    const { itemKey, variantId, quantity } = line;
    const idempotencyKey = buildSyncIdempotencyKey({
      shop,
      siNumber,
      itemKey,
      variantId,
      deltaQuantity: quantity,
    });

    let claim: Awaited<ReturnType<typeof claimInventorySyncLedger>>;
    try {
      claim = await claimInventorySyncLedger({
        shopId: shop,
        siNumber,
        itemKey,
        variantId,
        deltaQuantity: quantity,
        idempotencyKey,
      });
    } catch (error) {
      results.push({
        variant_id: variantId,
        item_key: itemKey,
        sync_status: "retryable-failure",
        delta: quantity,
        error: error instanceof Error ? error.message : String(error),
        errorType: "ledger_claim",
        failedStep: "claim",
      });
      continue;
    }

    if (claim.action === "already_synced" && claim.row) {
      results.push(
        resultFromLedger(claim.row, "already-synced", {
          strategy_used: "ledger-short-circuit",
        }),
      );
      continue;
    }

    if (claim.action === "manual_review" && claim.row) {
      results.push(
        resultFromLedger(claim.row, "manual-review-required", {
          error: claim.row.error_message || "結果確認が必要です",
          strategy_used: "ledger-ambiguous",
        }),
      );
      continue;
    }

    if (claim.action === "terminal" && claim.row) {
      results.push(
        resultFromLedger(claim.row, "terminal-failure", {
          error: claim.row.error_message || "再実行できない失敗です",
          strategy_used: "ledger-terminal",
        }),
      );
      continue;
    }

    if (claim.action === "in_progress" && claim.row) {
      const resolved = await resolveStaleProcessing(claim.row, {
        correlationId: claim.correlationId,
      });
      if (resolved.status === "ambiguous") {
        results.push(
          resultFromLedger(resolved, "manual-review-required", {
            error: resolved.error_message || "結果確認が必要です",
            strategy_used: "stale-processing",
          }),
        );
      } else {
        results.push(
          resultFromLedger(resolved, "in-progress", {
            strategy_used: "ledger-in-progress",
          }),
        );
      }
      continue;
    }

    if (claim.action !== "claimed" || !claim.row) {
      results.push({
        variant_id: variantId,
        item_key: itemKey,
        sync_status: "retryable-failure",
        delta: quantity,
        error: `Ledger claim failed: ${claim.error_code || claim.action}`,
        errorType: "ledger_claim",
        failedStep: "claim",
      });
      continue;
    }

    const ledgerId = claim.row.id;
    const ledgerOwner = {
      id: ledgerId,
      claimToken: claim.row.claim_token ?? null,
      shopId: shop,
      siNumber,
      itemKey,
      idempotencyKey,
      correlationId: claim.correlationId,
    };
    let step = "variantQuery";

    try {
      const variantQuery = `
        query($id: ID!) {
          productVariant(id: $id) {
            id
            inventoryItem {
              id
              tracked
              requiresShipping
            }
            inventoryPolicy
            inventoryQuantity
            product {
              id
              title
            }
          }
        }
      `;

      const variantResult = await adminGraphql(admin, variantQuery, { id: variantId });
      if (variantResult.transportError) {
        await finalizeLedgerFailure({
          ...ledgerOwner,
          status: "failed_retryable",
          errorCode: "VARIANT_TRANSPORT",
          errorMessage: variantResult.transportError,
          locationId,
        });
        results.push({
          variant_id: variantId,
          item_key: itemKey,
          sync_status: "retryable-failure",
          delta: quantity,
          ledger_id: ledgerId,
          error: variantResult.transportError,
          errorType: "transport",
          failedStep: step,
        });
        continue;
      }

      const variantData = variantResult.data;
      const variantErrorCheck = hasErrors(variantData);
      if (!variantResult.ok || variantErrorCheck.hasGraphQLErrors) {
        await finalizeLedgerFailure({
          ...ledgerOwner,
          status: "failed_retryable",
          errorCode: "VARIANT_GRAPHQL",
          errorMessage: "バリアントGraphQLエラー",
          locationId,
        });
        results.push({
          variant_id: variantId,
          item_key: itemKey,
          sync_status: "retryable-failure",
          delta: quantity,
          ledger_id: ledgerId,
          error: "バリアントGraphQLエラー",
          errorType: "graphql",
          failedStep: step,
          graphqlErrors: variantData?.errors,
        });
        continue;
      }

      const variant = variantData?.data?.productVariant;
      if (!variant) {
        await finalizeLedgerFailure({
          ...ledgerOwner,
          status: "failed_terminal",
          errorCode: "VARIANT_NOT_FOUND",
          errorMessage: "バリアントが見つかりません",
          locationId,
        });
        results.push({
          variant_id: variantId,
          item_key: itemKey,
          sync_status: "terminal-failure",
          delta: quantity,
          ledger_id: ledgerId,
          error: "バリアントが見つかりません",
          errorType: "logic",
          failedStep: step,
        });
        continue;
      }

      const inventoryItemId = variant.inventoryItem?.id as string | undefined;
      if (!inventoryItemId) {
        await finalizeLedgerFailure({
          ...ledgerOwner,
          status: "failed_terminal",
          errorCode: "NO_INVENTORY_ITEM",
          errorMessage: "inventory_item_idが取得できませんでした",
          locationId,
        });
        results.push({
          variant_id: variantId,
          item_key: itemKey,
          sync_status: "terminal-failure",
          delta: quantity,
          ledger_id: ledgerId,
          error: "inventory_item_idが取得できませんでした",
          errorType: "logic",
          failedStep: "inventoryItem",
        });
        continue;
      }

      if (!variant.inventoryItem.tracked) {
        step = "inventoryItemUpdate";
        await adminGraphql(
          admin,
          `
            mutation($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { id tracked }
                userErrors { field message }
              }
            }
          `,
          { id: inventoryItemId, input: { tracked: true } },
        );
      }

      step = "inventoryAdjustQuantities";
      const referenceDocumentUri = `app://track-to-inventory/sync/${encodeURIComponent(shop)}/${encodeURIComponent(siNumber)}/${encodeURIComponent(itemKey)}`;

      const adjust = await adjustWithIdempotency({
        admin,
        inventoryItemId,
        locationId,
        delta: quantity,
        idempotencyKey,
        referenceDocumentUri,
        currentQuantity: Number(variant.inventoryQuantity) || 0,
      });

      if (adjust.outcome === "success") {
        let recorded = false;
        try {
          recorded = await finalizeLedgerSuccess({
            ...ledgerOwner,
            inventoryItemId,
            locationId,
            shopifyAdjustmentId: adjust.adjustmentId,
          });
        } catch {
          recorded = false;
        }

        if (!recorded) {
          // Shopify likely succeeded; do not allow normal retry to call Shopify again.
          try {
            await finalizeLedgerFailure({
              ...ledgerOwner,
              status: "ambiguous",
              errorCode: "SUCCESS_RECORD_FAILED",
              errorMessage:
                "Shopify adjustment likely succeeded but ledger success write failed. Manual review required.",
              inventoryItemId,
              locationId,
            });
          } catch {
            // leave processing → stale detector will mark ambiguous
          }
          results.push({
            variant_id: variantId,
            item_key: itemKey,
            sync_status: "manual-review-required",
            product_title: variant.product.title,
            before_quantity: variant.inventoryQuantity,
            delta: quantity,
            after_quantity: variant.inventoryQuantity + quantity,
            tracking_enabled: variant.inventoryItem.tracked,
            response: adjust.group,
            strategy_used: adjust.strategy,
            ledger_id: ledgerId,
            shopify_adjustment_id: adjust.adjustmentId,
            error: "結果確認が必要です（成功記録に失敗）",
          });
          continue;
        }

        const result: SyncStockResult = {
          variant_id: variantId,
          item_key: itemKey,
          sync_status: "synced",
          product_title: variant.product.title,
          before_quantity: variant.inventoryQuantity,
          delta: quantity,
          after_quantity: variant.inventoryQuantity + quantity,
          tracking_enabled: variant.inventoryItem.tracked,
          response: adjust.group,
          errors: [],
          strategy_used: adjust.strategy,
          ledger_id: ledgerId,
          shopify_adjustment_id: adjust.adjustmentId,
        };
        results.push(result);

        console.log(
          JSON.stringify({
            event: "sync-stock",
            shop,
            siNumber,
            item_key: itemKey,
            variant_id: variantId,
            locationId,
            locationName,
            before: result.before_quantity,
            delta: result.delta,
            after: result.after_quantity,
            strategy: adjust.strategy,
            ledger_id: ledgerId,
          }),
        );
        continue;
      }

      if (adjust.outcome === "ambiguous") {
        await finalizeLedgerFailure({
          ...ledgerOwner,
          status: "ambiguous",
          errorCode: "AMBIGUOUS_OUTCOME",
          errorMessage: adjust.errorMessage || "Shopify outcome unknown",
          inventoryItemId,
          locationId,
        });
        results.push({
          variant_id: variantId,
          item_key: itemKey,
          sync_status: "manual-review-required",
          product_title: variant.product.title,
          delta: quantity,
          ledger_id: ledgerId,
          error: "結果確認が必要です",
          errorType: "ambiguous",
          failedStep: step,
          errors: adjust.userErrors,
          graphqlErrors: adjust.graphqlErrors,
        });
        continue;
      }

      if (adjust.strategy === "idempotency-concurrent") {
        // Leave ledger as processing; do not reopen for automatic re-adjust.
        results.push({
          variant_id: variantId,
          item_key: itemKey,
          sync_status: "in-progress",
          delta: quantity,
          ledger_id: ledgerId,
          error: "別リクエストが処理中です",
          errorType: "concurrent",
          failedStep: step,
          errors: adjust.userErrors,
        });
        continue;
      }

      const failureStatus =
        adjust.outcome === "user_error"
          ? classifyUserErrors(adjust.userErrors || [])
          : "failed_retryable";

      await finalizeLedgerFailure({
        ...ledgerOwner,
        status: failureStatus,
        errorCode: adjust.outcome.toUpperCase(),
        errorMessage: adjust.errorMessage || "在庫調整に失敗しました",
        inventoryItemId,
        locationId,
      });

      results.push({
        variant_id: variantId,
        item_key: itemKey,
        sync_status:
          failureStatus === "failed_terminal" ? "terminal-failure" : "retryable-failure",
        product_title: variant.product.title,
        delta: quantity,
        ledger_id: ledgerId,
        error: "在庫調整に失敗しました",
        errorType: adjust.outcome,
        failedStep: step,
        errors: adjust.userErrors,
        graphqlErrors: adjust.graphqlErrors,
        strategy_used: adjust.strategy || step,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await finalizeLedgerFailure({
          ...ledgerOwner,
          status: "ambiguous",
          errorCode: "EXCEPTION",
          errorMessage: message,
          locationId,
        });
      } catch {
        // ignore
      }
      results.push({
        variant_id: variantId,
        item_key: itemKey,
        sync_status: "manual-review-required",
        delta: quantity,
        ledger_id: ledgerId,
        error: message,
        errorType: "exception",
        failedStep: step,
      });
    }
  }

  return { results };
}
