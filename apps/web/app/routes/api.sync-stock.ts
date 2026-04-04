import { data as json, type ActionFunctionArgs } from "react-router";
import { isExternalSyncConfigured, proxySyncStockRequest } from "~/lib/syncBackend.server";
import { authenticate } from "~/shopify.server";
import { unauthenticated } from "~/shopify.server";

type UserError = {
  field?: string[] | null;
  message: string;
};

type SyncResult = {
  variant_id: string;
  product_title?: string;
  before_quantity?: number;
  delta?: number;
  after_quantity?: number;
  tracking_enabled?: boolean;
  response?: unknown;
  errors?: UserError[];
  strategy_used?: string;
  error?: string;
  errorType?: string;
  failedStep?: string;
  graphqlErrors?: unknown;
};

function logGraphQLResponse(_step: string, _data: any, _variables?: any) {}

function hasErrors(data: any): { hasGraphQLErrors: boolean; hasUserErrors: boolean; userErrors: UserError[] } {
  const hasGraphQLErrors = Array.isArray(data?.errors) && data.errors.length > 0;

  function findUserErrors(obj: any): UserError[] {
    const userErrors: UserError[] = [];

    if (obj && typeof obj === "object") {
      if (Array.isArray(obj.userErrors)) {
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

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10000): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    if (isExternalSyncConfigured()) {
      return await proxySyncStockRequest(request);
    }
    const url = new URL(request.url);
    const body = await withTimeout(request.json(), "sync-stock request.json", 10000);
    const { items } = body;
    const shopIdFromQuery = url.searchParams.get("shop_id") || "";
    const shopIdFromBody = typeof body?.shop_id === "string" ? body.shop_id : "";
    const shopId = shopIdFromQuery || shopIdFromBody;

    let admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"] | undefined;
    let session: Awaited<ReturnType<typeof authenticate.admin>>["session"] | undefined;

    if (shopId) {
      try {
        const unauthenticatedAdmin = await withTimeout(
          unauthenticated.admin(shopId),
          "sync-stock unauthenticated.admin",
          10000,
        );
        admin = unauthenticatedAdmin.admin;
      } catch (error) {
        ({ admin, session } = await authenticate.admin(request));
      }
    } else {
      ({ admin, session } = await authenticate.admin(request));
    }
    
    // アプリの権限情報をログ出力
    
    if (!items || items.length === 0) {
      return json({ error: "No items to sync" }, { status: 400 });
    }

    // ストアのLocation IDを動的に取得
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
    const locationResult = await admin.graphql(locationsQuery);
    
    const locationData = await locationResult.json();
    logGraphQLResponse("Location取得", locationData);
    
    if (!locationData || !locationData.data || !locationData.data.locations) {
      return json({ 
        error: "Failed to fetch location information",
        debug: locationData 
      }, { status: 400 });
    }

    const locations = locationData.data.locations.edges;
    
    if (!locations || locations.length === 0) {
      return json({ error: "No location found for this store" }, { status: 400 });
    }
    
    // 最初のアクティブなロケーション（通常はメインロケーション）を使用
    const primaryLocation = locations.find((loc: any) => loc.node.isPrimary) || locations[0];
    const locationId = primaryLocation.node.id;

    const results: SyncResult[] = [];
    
    for (const item of items) {
      let step = "variantQuery";
      try {
        
        // 1. バリアント情報を詳細取得（在庫設定含む）
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
        
        const variantRes = await admin.graphql(variantQuery, { 
          variables: variantVariables 
        });
        const variantData = await variantRes.json() as { data?: any; errors?: any };
        
        logGraphQLResponse("バリアント取得", variantData, variantVariables);
        
        const { hasGraphQLErrors, hasUserErrors, userErrors } = hasErrors(variantData);
        
        if (hasGraphQLErrors) {
          results.push({
            variant_id: item.variant_id,
            error: "Variant GraphQL error",
            errorType: "graphql",
            failedStep: step,
            graphqlErrors: variantData.errors,
          });
          continue;
        }

        const variant = variantData.data?.productVariant;
        if (!variant) {
          results.push({
            variant_id: item.variant_id,
            error: "Variant not found",
            errorType: "logic",
            failedStep: step,
          });
          continue;
        }

        const inventoryItemId = variant.inventoryItem?.id;
        if (!inventoryItemId) {
          results.push({
            variant_id: item.variant_id,
            error: "Failed to resolve inventory_item_id",
            errorType: "logic",
            failedStep: "inventoryItem",
          });
          continue;
        }

        // 2. 在庫追跡が無効の場合は有効にする
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
              tracked: true
            }
          };
          
          const trackingResult = await admin.graphql(enableTrackingMutation, {
            variables: trackingVariables
          });
          
          const trackingData = await trackingResult.json() as { data?: any; errors?: any };
          logGraphQLResponse("在庫追跡有効化", trackingData, trackingVariables);
          
          const trackingErrorCheck = hasErrors(trackingData);
          if (trackingErrorCheck.hasGraphQLErrors) {
            // 在庫追跡有効化が失敗しても在庫調整は続行
          } else if (trackingErrorCheck.hasUserErrors) {
            // 在庫追跡有効化が失敗しても在庫調整は続行
          } else {
          }
        }

        // 3. バリアントの在庫管理設定を更新
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
                inventoryPolicy: 'DENY' // 在庫切れ時は販売停止
              }
            ]
          };
          
          const variantUpdateResult = await admin.graphql(variantUpdateMutation, {
            variables: variantUpdateVariables
          });
          
          const variantUpdateData = await variantUpdateResult.json() as { data?: any; errors?: any };
          logGraphQLResponse("バリアント更新", variantUpdateData, variantUpdateVariables);
          
          const variantUpdateErrorCheck = hasErrors(variantUpdateData);
          if (variantUpdateErrorCheck.hasGraphQLErrors) {
            // バリアント更新が失敗しても在庫調整は続行
          } else if (variantUpdateErrorCheck.hasUserErrors) {
            // バリアント更新が失敗しても在庫調整は続行
          } else {
          }
        }

        // 4. 在庫数量を調整 - 安定版APIに合わせて修正
        let adjData: any = null;
        let success = false;
        let adjUserErrors: UserError[] = [];
        let adjGraphqlErrors: unknown = undefined;
        let usedStrategy = "";
        
        // 戦略1: inventoryAdjustQuantities (安定版)
        step = "inventoryAdjustQuantities";
        try {
          
          const adjMutation = `
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
          
          const mutationVariables = {
            input: {
              reason: "correction",
              name: "available",
              changes: [
                {
                  delta: item.quantity,
                  inventoryItemId: inventoryItemId,
                  locationId: locationId
                }
              ]
            }
          };
          
          const adjResult = await admin.graphql(adjMutation, {
            variables: mutationVariables
          });
          
          adjData = await adjResult.json() as { data?: any; errors?: any };
          logGraphQLResponse("戦略1: inventoryAdjustQuantities", adjData, mutationVariables);
          
          const strategy1ErrorCheck = hasErrors(adjData);
          if (strategy1ErrorCheck.hasGraphQLErrors) {
            adjGraphqlErrors = adjData.errors;
          } else if (!strategy1ErrorCheck.hasUserErrors) {
            success = true;
            usedStrategy = "inventoryAdjustQuantities";
          } else {
            adjUserErrors = strategy1ErrorCheck.userErrors;
          }
          
        } catch (strategy1Error) {
          adjUserErrors = [{ message: String(strategy1Error) }];
        }
        
        // 戦略2: inventoryAdjustQuantity (単数形) - より安定したAPI
        if (!success) {
          step = "inventoryAdjustQuantity";
          try {
            // 正確なInventoryLevel IDを取得
            const inventoryLevelQuery = `
              query($inventoryItemIds: [ID!]!, $locationIds: [ID!]!) {
                inventoryLevels(inventoryItemIds: $inventoryItemIds, locationIds: $locationIds) {
                  id
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            `;
            const levelQueryVariables = {
              inventoryItemIds: [inventoryItemId],
              locationIds: [locationId]
            };
            const levelResult = await admin.graphql(inventoryLevelQuery, {
              variables: levelQueryVariables
            });
            const levelData = await levelResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("InventoryLevel取得", levelData, levelQueryVariables);
            const levelErrorCheck = hasErrors(levelData);
            if (levelErrorCheck.hasGraphQLErrors || levelErrorCheck.hasUserErrors) {
              throw new Error("Failed to fetch inventory level");
            }
            const inventoryLevels = levelData.data?.inventoryLevels;
            let inventoryLevelId: string | undefined;
            if (!inventoryLevels || inventoryLevels.length === 0) {
              // inventoryActivateで自動紐付けを試みる
              const activateMutation = `
                mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
                  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
                    inventoryLevel {
                      id
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }
              `;
              const activateVariables = {
                inventoryItemId: inventoryItemId,
                locationId: locationId
              };
              const activateResult = await admin.graphql(activateMutation, { variables: activateVariables });
              const activateData = await activateResult.json();
              logGraphQLResponse("inventoryActivate", activateData, activateVariables);
              const activateErrors = hasErrors(activateData);
              if (activateErrors.hasGraphQLErrors || activateErrors.hasUserErrors) {
              results.push({
                variant_id: item.variant_id,
                error: "This product is not tracked at the current location and could not be activated. Please enable inventory tracking in your Shopify admin.",
                errorType: "inventoryLevelActivateFailed",
                failedStep: step,
                errors: activateErrors.userErrors,
                  graphqlErrors: [],
                });
                continue;
              }
              // 再度inventoryLevel取得
              inventoryLevelId = activateData.data?.inventoryActivate?.inventoryLevel?.id;
              if (!inventoryLevelId) {
                results.push({
                  variant_id: item.variant_id,
                  error: "Inventory level activation succeeded but no inventoryLevel ID was returned.",
                  errorType: "inventoryLevelActivateNoId",
                  failedStep: step,
                });
                continue;
              }
            } else {
              inventoryLevelId = inventoryLevels[0].id;
              // quantities配列からavailableを取得
              const availableObj = inventoryLevels[0].quantities?.find((q: any) => q.name === "available");
            }
            // adjustQuantityMutation以下の処理でinventoryLevelIdを使う
            const adjustQuantityMutation = `
              mutation($input: InventoryAdjustQuantityInput!) {
                inventoryAdjustQuantity(input: $input) {
                  inventoryLevel {
                    id
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;
            const adjustQuantityVariables = {
              input: {
                inventoryLevelId: inventoryLevelId,
                delta: item.quantity
              }
            };
            const adjustResult = await admin.graphql(adjustQuantityMutation, {
              variables: adjustQuantityVariables
            });
            adjData = await adjustResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("戦略2: inventoryAdjustQuantity", adjData, adjustQuantityVariables);
            const strategy2ErrorCheck = hasErrors(adjData);
            if (strategy2ErrorCheck.hasGraphQLErrors) {
              adjGraphqlErrors = adjData.errors;
            } else if (!strategy2ErrorCheck.hasUserErrors) {
              success = true;
              usedStrategy = "inventoryAdjustQuantity";
            } else {
              adjUserErrors = strategy2ErrorCheck.userErrors;
            }
          } catch (strategy2Error) {
            adjUserErrors = [{ message: String(strategy2Error) }];
          }
        }
        
        // 戦略3: inventorySetQuantities (フォールバック)
        if (!success) {
          step = "inventorySetQuantities";
          try {
            
            // 現在の在庫量を取得
            const currentQuantity = Number(variant.inventoryQuantity) || 0;
            const delta = Number(item.quantity) || 0;
            const newQuantity = Math.max(0, currentQuantity + delta);
            
            const setQuantitiesMutation = `
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
            
            const setQuantitiesVariables = {
              input: {
                name: "available",
                reason: "correction",
                ignoreCompareQuantity: true,
                quantities: [
                  {
                    inventoryItemId: inventoryItemId,
                    locationId: locationId,
                    quantity: newQuantity
                  }
                ]
              }
            };
            
            const setResult = await admin.graphql(setQuantitiesMutation, {
              variables: setQuantitiesVariables
            });
            
            adjData = await setResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("戦略3: inventorySetQuantities", adjData, setQuantitiesVariables);
            
            const strategy3ErrorCheck = hasErrors(adjData);
            if (strategy3ErrorCheck.hasGraphQLErrors) {
              adjGraphqlErrors = adjData.errors;
            } else if (!strategy3ErrorCheck.hasUserErrors) {
              success = true;
              usedStrategy = "inventorySetQuantities";
            } else {
              adjUserErrors = strategy3ErrorCheck.userErrors;
            }
            
          } catch (strategy3Error) {
            adjUserErrors = [{ message: String(strategy3Error) }];
          }
        }
        
        // 戦略4: inventoryAdjustQuantities (最後の手段) - inventoryActivate対応版
        if (!success) {
          step = "inventoryAdjustQuantities";
          try {
            
            // まずinventoryActivateで在庫管理を開始
            const activateMutation = `
              mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
                inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
                  inventoryLevel {
                    id
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;
            const activateVariables = {
              inventoryItemId: inventoryItemId,
              locationId: locationId
            };
            const activateResult = await admin.graphql(activateMutation, { variables: activateVariables });
            const activateData = await activateResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("戦略4: inventoryActivate", activateData, activateVariables);
            
            const activateErrors = hasErrors(activateData);
            if (activateErrors.hasGraphQLErrors || activateErrors.hasUserErrors) {
              adjUserErrors = activateErrors.userErrors;
              adjGraphqlErrors = activateData.errors;
            } else {
              
              // inventoryActivate成功後、在庫調整を実行
              const bulkAdjustMutation = `
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
              
              const bulkAdjustVariables = {
                input: {
                  reason: "correction",
                  name: "available",
                  changes: [
                    {
                      delta: item.quantity,
                      inventoryItemId: inventoryItemId,
                      locationId: locationId
                    }
                  ]
                }
              };
              
              const bulkResult = await admin.graphql(bulkAdjustMutation, {
                variables: bulkAdjustVariables
              });
              
              adjData = await bulkResult.json() as { data?: any; errors?: any };
              logGraphQLResponse("戦略4: inventoryAdjustQuantities", adjData, bulkAdjustVariables);
              
              const strategy4ErrorCheck = hasErrors(adjData);
              if (strategy4ErrorCheck.hasGraphQLErrors) {
                adjGraphqlErrors = adjData.errors;
              } else if (!strategy4ErrorCheck.hasUserErrors) {
                success = true;
                usedStrategy = "inventoryAdjustQuantities";
              } else {
                adjUserErrors = strategy4ErrorCheck.userErrors;
              }
            }
            
          } catch (strategy4Error) {
            adjUserErrors = [{ message: String(strategy4Error) }];
          }
        }
        
        // 戦略1・2ともに失敗した場合のみエラー記録
        if (success) {
          results.push({
            variant_id: item.variant_id,
            product_title: variant.product.title,
            before_quantity: variant.inventoryQuantity,
            delta: item.quantity,
            after_quantity: variant.inventoryQuantity + item.quantity,
            tracking_enabled: variant.inventoryItem.tracked,
            response: adjData?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup || 
                     adjData?.data?.inventoryAdjustQuantity?.inventoryLevel ||
                     adjData?.data?.inventorySetQuantities?.inventoryAdjustmentGroup ||
                     adjData?.data?.inventoryBulkAdjustQuantityAtLocation?.inventoryAdjustmentGroup,
            errors: [],
            strategy_used: usedStrategy,
          });
        } else {
          results.push({
            variant_id: item.variant_id,
            error: "Inventory adjustment failed",
            errorType: adjGraphqlErrors ? "graphql" : (adjUserErrors.length ? "userError" : "unknown"),
            failedStep: step,
            errors: adjUserErrors,
            graphqlErrors: adjGraphqlErrors,
            strategy_used: usedStrategy || step,
          });
        }
      } catch (itemError) {
        results.push({
          variant_id: item.variant_id,
          error: itemError instanceof Error ? itemError.message : String(itemError),
          errorType: "exception",
          failedStep: step,
        });
      }
    }
    return json({ results });
  } catch (error) {
    return json({ 
      error: error instanceof Error ? error.message : String(error),
      debug: error instanceof Error ? error.stack : undefined
    }, { status: 500 });
  }
}; 
