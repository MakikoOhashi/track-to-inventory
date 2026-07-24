import { createSupabaseAdminClient } from "~/lib/supabase.server";

export type SyncStockItemInput = {
  variant_id?: string;
  quantity?: unknown;
};

export type SyncStockResult = {
  variant_id: string;
  product_title?: string;
  before_quantity?: number;
  delta?: number;
  after_quantity?: number;
  tracking_enabled?: boolean;
  response?: unknown;
  errors?: Array<{ field?: string[] | null; message: string }>;
  strategy_used?: string;
  error?: string;
  errorType?: string;
  failedStep?: string;
  graphqlErrors?: unknown;
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

type UserError = { field?: string[] | null; message: string };

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
): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

/**
 * Confirm the shipment belongs to the authenticated shop and that sync items
 * are drawn from that shipment's line items (variant_id set).
 */
export async function assertShipmentOwnedForSync(params: {
  shop: string;
  siNumber: string;
  items: SyncStockItemInput[];
}): Promise<void> {
  const { shop, siNumber, items } = params;
  if (!siNumber || typeof siNumber !== "string") {
    throw new SyncStockError("SI_REQUIRED", "SI番号が必要です", 400);
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shipments")
    .select("shop_id, items")
    .eq("si_number", siNumber)
    .eq("shop_id", shop)
    .maybeSingle();

  if (error) {
    throw new SyncStockError("DB_ERROR", "データベースエラー", 500);
  }

  if (!data) {
    throw new SyncStockError("NOT_FOUND", "出荷データが見つかりません", 404);
  }

  const allowed = new Set(
    (Array.isArray(data.items) ? data.items : [])
      .map((item: { variant_id?: string }) => item?.variant_id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
  );

  for (const item of items) {
    if (!item?.variant_id || !allowed.has(item.variant_id)) {
      throw new SyncStockError("FORBIDDEN_ITEM", "同期対象の商品が不正です", 403);
    }
  }
}

/**
 * Stock sync behavior (Workers):
 * - Primary: inventoryAdjustQuantities with delta = item.quantity (NOT absolute set)
 * - Fallback: inventorySetQuantities to max(0, current + delta)
 * - Duplicate variant_id in one request is skipped (no second adjust)
 */
export async function syncShipmentStock(params: {
  admin: AdminClient;
  shop: string;
  siNumber: string;
  items: SyncStockItemInput[];
}): Promise<{ results: SyncStockResult[] }> {
  const { admin, shop, siNumber, items } = params;

  if (!Array.isArray(items) || items.length === 0) {
    throw new SyncStockError("NO_ITEMS", "同期する商品がありません", 400);
  }

  for (const item of items) {
    if (!item?.variant_id || typeof item.variant_id !== "string") {
      throw new SyncStockError("INVALID_ITEM", "variant_idが必要です", 400);
    }
  }

  await assertShipmentOwnedForSync({ shop, siNumber, items });

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
  if (!locationResult.ok || !locationResult.data?.data?.locations?.edges?.length) {
    throw new SyncStockError("NO_LOCATION", "ロケーション情報を取得できませんでした", 400);
  }

  const locations = locationResult.data.data.locations.edges;
  const primaryLocation = locations.find((loc: { node: { isPrimary?: boolean } }) => loc.node.isPrimary) || locations[0];
  const locationId = primaryLocation.node.id as string;
  const locationName = primaryLocation.node.name as string | undefined;

  const seenVariantIds = new Set<string>();
  const results: SyncStockResult[] = [];

  for (const item of items) {
    const variantId = item.variant_id as string;
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
      const variantData = variantResult.data;
      const variantErrorCheck = hasErrors(variantData);

      if (!variantResult.ok || variantErrorCheck.hasGraphQLErrors) {
        results.push({
          variant_id: variantId,
          error: "バリアントGraphQLエラー",
          errorType: "graphql",
          failedStep: step,
          graphqlErrors: variantData?.errors,
        });
        continue;
      }

      const variant = variantData?.data?.productVariant;
      if (!variant) {
        results.push({
          variant_id: variantId,
          error: "バリアントが見つかりません",
          errorType: "logic",
          failedStep: step,
        });
        continue;
      }

      const inventoryItemId = variant.inventoryItem?.id as string | undefined;
      if (!inventoryItemId) {
        results.push({
          variant_id: variantId,
          error: "inventory_item_idが取得できませんでした",
          errorType: "logic",
          failedStep: "inventoryItem",
        });
        continue;
      }

      const normalizedQuantity = Number(item.quantity);
      if (!Number.isFinite(normalizedQuantity)) {
        results.push({
          variant_id: variantId,
          error: "quantityが数値ではありません",
          errorType: "logic",
          failedStep: "quantityNormalize",
        });
        continue;
      }

      if (seenVariantIds.has(variantId)) {
        results.push({
          variant_id: variantId,
          product_title: variant.product.title,
          before_quantity: variant.inventoryQuantity,
          delta: normalizedQuantity,
          after_quantity: variant.inventoryQuantity,
          tracking_enabled: variant.inventoryItem.tracked,
          response: null,
          errors: [],
          strategy_used: "skipped-duplicate-variant",
        });
        continue;
      }
      seenVariantIds.add(variantId);

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

      if (!variant.inventoryItem.tracked) {
        step = "productVariantUpdate";
        await adminGraphql(
          admin,
          `
            mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants { id inventoryPolicy }
                userErrors { field message }
              }
            }
          `,
          {
            productId: variant.product.id,
            variants: [{ id: variantId, inventoryPolicy: "DENY" }],
          },
        );
      }

      let success = false;
      let adjData: any = null;
      let adjUserErrors: UserError[] = [];
      let adjGraphqlErrors: unknown;
      let usedStrategy = "";

      step = "inventoryAdjustQuantities";
      try {
        const adjustResult = await adminGraphql(
          admin,
          `
            mutation($input: InventoryAdjustQuantitiesInput!) {
              inventoryAdjustQuantities(input: $input) {
                inventoryAdjustmentGroup {
                  createdAt
                  reason
                  changes { name delta }
                }
                userErrors { field message }
              }
            }
          `,
          {
            input: {
              reason: "correction",
              name: "available",
              changes: [
                {
                  delta: normalizedQuantity,
                  inventoryItemId,
                  locationId,
                },
              ],
            },
          },
        );
        adjData = adjustResult.data;
        const adjustErrorCheck = hasErrors(adjData);
        if (!adjustResult.ok || adjustErrorCheck.hasGraphQLErrors) {
          adjGraphqlErrors = adjData?.errors;
        } else if (!adjustErrorCheck.hasUserErrors) {
          success = true;
          usedStrategy = "inventoryAdjustQuantities";
        } else {
          adjUserErrors = adjustErrorCheck.userErrors;
        }
      } catch (error) {
        adjUserErrors = [{ message: String(error) }];
      }

      if (!success) {
        step = "inventorySetQuantities";
        try {
          const currentQuantity = Number(variant.inventoryQuantity) || 0;
          const newQuantity = Math.max(0, currentQuantity + normalizedQuantity);

          const setResult = await adminGraphql(
            admin,
            `
              mutation($input: InventorySetQuantitiesInput!) {
                inventorySetQuantities(input: $input) {
                  inventoryAdjustmentGroup {
                    reason
                    changes {
                      delta
                      quantityAfterChange
                      item { id }
                      location { id }
                    }
                  }
                  userErrors { field message }
                }
              }
            `,
            {
              input: {
                name: "available",
                reason: "correction",
                ignoreCompareQuantity: true,
                quantities: [
                  {
                    inventoryItemId,
                    locationId,
                    quantity: newQuantity,
                  },
                ],
              },
            },
          );
          adjData = setResult.data;
          const setErrorCheck = hasErrors(adjData);
          if (!setResult.ok || setErrorCheck.hasGraphQLErrors) {
            adjGraphqlErrors = adjData?.errors;
          } else if (!setErrorCheck.hasUserErrors) {
            success = true;
            usedStrategy = "inventorySetQuantities";
          } else {
            adjUserErrors = setErrorCheck.userErrors;
          }
        } catch (error) {
          adjUserErrors = [{ message: String(error) }];
        }
      }

      if (success) {
        const result: SyncStockResult = {
          variant_id: variantId,
          product_title: variant.product.title,
          before_quantity: variant.inventoryQuantity,
          delta: normalizedQuantity,
          after_quantity: variant.inventoryQuantity + normalizedQuantity,
          tracking_enabled: variant.inventoryItem.tracked,
          response:
            adjData?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup ||
            adjData?.data?.inventorySetQuantities?.inventoryAdjustmentGroup,
          errors: [],
          strategy_used: usedStrategy,
        };
        results.push(result);

        // Auditable, secret-free sync record
        console.log(
          JSON.stringify({
            event: "sync-stock",
            shop,
            siNumber,
            variant_id: variantId,
            locationId,
            locationName,
            before: result.before_quantity,
            delta: result.delta,
            after: result.after_quantity,
            strategy: usedStrategy,
          }),
        );
      } else {
        results.push({
          variant_id: variantId,
          error: "在庫調整に失敗しました",
          errorType: adjGraphqlErrors ? "graphql" : adjUserErrors.length ? "userError" : "unknown",
          failedStep: step,
          errors: adjUserErrors,
          graphqlErrors: adjGraphqlErrors,
          strategy_used: usedStrategy || step,
        });
      }
    } catch (error) {
      results.push({
        variant_id: variantId,
        error: error instanceof Error ? error.message : String(error),
        errorType: "exception",
        failedStep: step,
      });
    }
  }

  return { results };
}
