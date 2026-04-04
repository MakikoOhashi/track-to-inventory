import { Pool } from "pg";

class SyncHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
  }
}

function withTimeout(promise, label, timeoutMs = 10000) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function logGraphQLResponse(step, data, variables) {
  console.log(`\n=== ${step} 詳細ログ ===`);
  console.log("Variables:", JSON.stringify(variables, null, 2));
  console.log("Response:", JSON.stringify(data, null, 2));

  if (data?.errors && Array.isArray(data.errors)) {
    console.error(`\n${step} GraphQL Errors:`);
    data.errors.forEach((error, index) => {
      console.error(`  Error ${index + 1}:`, {
        message: error.message,
        extensions: error.extensions,
        path: error.path,
        locations: error.locations,
        code: error.extensions?.code,
        fullError: error,
      });
    });
  }

  console.log(`=== ${step} ログ終了 ===\n`);
}

function hasErrors(data) {
  const hasGraphQLErrors = data?.errors && Array.isArray(data.errors) && data.errors.length > 0;

  function findUserErrors(obj) {
    const userErrors = [];

    if (obj && typeof obj === "object") {
      if (obj.userErrors && Array.isArray(obj.userErrors)) {
        userErrors.push(...obj.userErrors);
      }

      for (const value of Object.values(obj)) {
        if (value && typeof value === "object") {
          userErrors.push(...findUserErrors(value));
        }
      }
    }

    return userErrors;
  }

  const userErrors = findUserErrors(data);
  return { hasGraphQLErrors, hasUserErrors: userErrors.length > 0, userErrors };
}

let pool;
function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new SyncHttpError(500, "DATABASE_URL is required for sync backend");
  }

  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
  });

  return pool;
}

async function getOfflineAccessToken(shopId) {
  const pool = getPool();
  const query = `
    SELECT "accessToken"
    FROM "TrackToInventorySession"
    WHERE "shop" = $1
      AND "isOnline" = false
    ORDER BY COALESCE("expires", NOW()) DESC
    LIMIT 1
  `;

  const result = await pool.query(query, [shopId]);
  const token = result.rows?.[0]?.accessToken;
  if (!token) {
    throw new SyncHttpError(401, `Offline session not found for shop: ${shopId}`);
  }

  return token;
}

async function shopifyGraphQL(shopId, accessToken, query, variables) {
  const response = await fetch(`https://${shopId}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

export async function handleSyncStock(request) {
  const url = new URL(request.url);
  const body = await withTimeout(request.json(), "sync-stock request.json", 10000);
  const items = body?.items;
  const shopId = url.searchParams.get("shop_id") || body?.shop_id || "";

  if (!shopId) {
    throw new SyncHttpError(400, "shop_id is required");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new SyncHttpError(400, "同期する商品がありません");
  }

  const accessToken = await getOfflineAccessToken(shopId);

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

  const locationResult = await shopifyGraphQL(shopId, accessToken, locationsQuery, undefined);
  logGraphQLResponse("Location取得", locationResult.data);

  if (!locationResult.ok || !locationResult.data?.data?.locations?.edges?.length) {
    throw new SyncHttpError(400, "ロケーション情報を取得できませんでした");
  }

  const locations = locationResult.data.data.locations.edges;
  const primaryLocation = locations.find((loc) => loc.node.isPrimary) || locations[0];
  const locationId = primaryLocation.node.id;

  const results = [];

  for (const item of items) {
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

      const variantVariables = { id: item.variant_id };
      const variantResult = await shopifyGraphQL(shopId, accessToken, variantQuery, variantVariables);
      const variantData = variantResult.data;
      logGraphQLResponse("バリアント取得", variantData, variantVariables);

      const variantErrorCheck = hasErrors(variantData);
      if (!variantResult.ok || variantErrorCheck.hasGraphQLErrors) {
        results.push({
          variant_id: item.variant_id,
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
          variant_id: item.variant_id,
          error: "バリアントが見つかりません",
          errorType: "logic",
          failedStep: step,
        });
        continue;
      }

      const inventoryItemId = variant.inventoryItem?.id;
      if (!inventoryItemId) {
        results.push({
          variant_id: item.variant_id,
          error: "inventory_item_idが取得できませんでした",
          errorType: "logic",
          failedStep: "inventoryItem",
        });
        continue;
      }

      if (!variant.inventoryItem.tracked) {
        step = "inventoryItemUpdate";
        const enableTrackingMutation = `
          mutation($id: ID!, $input: InventoryItemInput!) {
            inventoryItemUpdate(id: $id, input: $input) {
              inventoryItem {
                id
                tracked
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const trackingVariables = {
          id: inventoryItemId,
          input: {
            tracked: true,
          },
        };

        const trackingResult = await shopifyGraphQL(
          shopId,
          accessToken,
          enableTrackingMutation,
          trackingVariables,
        );
        logGraphQLResponse("在庫追跡有効化", trackingResult.data, trackingVariables);
      }

      if (!variant.inventoryItem.tracked) {
        step = "productVariantUpdate";
        const variantUpdateMutation = `
          mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants {
                id
                inventoryPolicy
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const variantUpdateVariables = {
          productId: variant.product.id,
          variants: [
            {
              id: item.variant_id,
              inventoryPolicy: "DENY",
            },
          ],
        };

        const variantUpdateResult = await shopifyGraphQL(
          shopId,
          accessToken,
          variantUpdateMutation,
          variantUpdateVariables,
        );
        logGraphQLResponse("バリアント更新", variantUpdateResult.data, variantUpdateVariables);
      }

      let success = false;
      let adjData = null;
      let adjUserErrors = [];
      let adjGraphqlErrors = undefined;
      let usedStrategy = "";

      step = "inventoryAdjustQuantities";
      try {
        const adjustMutation = `
          mutation($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
              inventoryAdjustmentGroup {
                createdAt
                reason
                changes {
                  name
                  delta
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const adjustVariables = {
          input: {
            reason: "correction",
            name: "available",
            changes: [
              {
                delta: item.quantity,
                inventoryItemId,
                locationId,
              },
            ],
          },
        };

        const adjustResult = await shopifyGraphQL(
          shopId,
          accessToken,
          adjustMutation,
          adjustVariables,
        );
        adjData = adjustResult.data;
        logGraphQLResponse("戦略1: inventoryAdjustQuantities", adjData, adjustVariables);

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
          const delta = Number(item.quantity) || 0;
          const newQuantity = Math.max(0, currentQuantity + delta);

          const setMutation = `
            mutation($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) {
                inventoryAdjustmentGroup {
                  reason
                  changes {
                    delta
                    quantityAfterChange
                    item {
                      id
                    }
                    location {
                      id
                    }
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `;

          const setVariables = {
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
          };

          const setResult = await shopifyGraphQL(shopId, accessToken, setMutation, setVariables);
          adjData = setResult.data;
          logGraphQLResponse("戦略2: inventorySetQuantities", adjData, setVariables);

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
        results.push({
          variant_id: item.variant_id,
          product_title: variant.product.title,
          before_quantity: variant.inventoryQuantity,
          delta: item.quantity,
          after_quantity: variant.inventoryQuantity + item.quantity,
          tracking_enabled: variant.inventoryItem.tracked,
          response:
            adjData?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup ||
            adjData?.data?.inventorySetQuantities?.inventoryAdjustmentGroup,
          errors: [],
          strategy_used: usedStrategy,
        });
      } else {
        results.push({
          variant_id: item.variant_id,
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
        variant_id: item.variant_id,
        error: error instanceof Error ? error.message : String(error),
        errorType: "exception",
        failedStep: step,
      });
    }
  }

  return { results };
}
