import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

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

// GraphQLレスポンスの詳細ログ出力関数
function logGraphQLResponse(step: string, data: any, variables?: any) {
  console.log(`\n=== ${step} 詳細ログ ===`);
  console.log("Variables:", JSON.stringify(variables, null, 2));
  console.log("Response:", JSON.stringify(data, null, 2));
  
  // GraphQL errorsの詳細表示
  if (data.errors && Array.isArray(data.errors)) {
    console.error(`\n${step} GraphQL Errors:`);
    data.errors.forEach((error: any, index: number) => {
      console.error(`  Error ${index + 1}:`, {
        message: error.message,
        extensions: error.extensions,
        path: error.path,
        locations: error.locations
      });
    });
  }
  
  // userErrorsの再帰的検索と表示
  function findUserErrors(obj: any, path: string = ""): UserError[] {
    const userErrors: UserError[] = [];
    
    if (obj && typeof obj === 'object') {
      if (obj.userErrors && Array.isArray(obj.userErrors)) {
        console.error(`\n${step} userErrors found at ${path}:`);
        obj.userErrors.forEach((error: UserError, index: number) => {
          console.error(`  UserError ${index + 1}:`, {
            field: error.field,
            message: error.message
          });
        });
        userErrors.push(...obj.userErrors);
      }
      
      // 再帰的に検索
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
          userErrors.push(...findUserErrors(value, `${path}.${key}`));
        }
      }
    }
    
    return userErrors;
  }
  
  const allUserErrors = findUserErrors(data);
  if (allUserErrors.length > 0) {
    console.error(`\n${step} 全userErrors (${allUserErrors.length}件):`, allUserErrors);
  }
  
  console.log(`=== ${step} ログ終了 ===\n`);
}

// エラー判定の改善された関数
function hasErrors(data: any): { hasGraphQLErrors: boolean; hasUserErrors: boolean; userErrors: UserError[] } {
  const hasGraphQLErrors = data.errors && Array.isArray(data.errors) && data.errors.length > 0;
  
  function findUserErrors(obj: any): UserError[] {
    const userErrors: UserError[] = [];
    
    if (obj && typeof obj === 'object') {
      if (obj.userErrors && Array.isArray(obj.userErrors)) {
        userErrors.push(...obj.userErrors);
      }
      
      // 再帰的に検索
      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
          userErrors.push(...findUserErrors(value));
        }
      }
    }
    
    return userErrors;
  }
  
  const userErrors = findUserErrors(data);
  const hasUserErrors = userErrors.length > 0;
  
  return { hasGraphQLErrors, hasUserErrors, userErrors };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { items } = await request.json();
    
    if (!items || items.length === 0) {
      return json({ error: "同期する商品がありません" }, { status: 400 });
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
    
    console.log("Location取得開始");
    const locationResult = await admin.graphql(locationsQuery);
    
    const locationData = await locationResult.json();
    logGraphQLResponse("Location取得", locationData);
    
    if (!locationData || !locationData.data || !locationData.data.locations) {
      return json({ 
        error: "ロケーション情報を取得できませんでした",
        debug: locationData 
      }, { status: 400 });
    }

    const locations = locationData.data.locations.edges;
    
    if (!locations || locations.length === 0) {
      return json({ error: "ストアにロケーションが見つかりません" }, { status: 400 });
    }
    
    // 最初のアクティブなロケーション（通常はメインロケーション）を使用
    const primaryLocation = locations.find((loc: any) => loc.node.isPrimary) || locations[0];
    const locationId = primaryLocation.node.id;
    
    console.log("使用するLocation ID:", locationId);

    const results: SyncResult[] = [];
    
    for (const item of items) {
      let step = "variantQuery";
      try {
        console.log(`\n=== バリアント処理開始: ${item.variant_id} ===`);
        console.log("処理対象:", { variant_id: item.variant_id, quantity: item.quantity });
        
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
        console.log("バリアント取得変数:", JSON.stringify(variantVariables, null, 2));
        
        const variantRes = await admin.graphql(variantQuery, { 
          variables: variantVariables 
        });
        const variantData = await variantRes.json() as { data?: any; errors?: any };
        
        logGraphQLResponse("バリアント取得", variantData, variantVariables);
        
        const { hasGraphQLErrors, hasUserErrors, userErrors } = hasErrors(variantData);
        
        if (hasGraphQLErrors) {
          results.push({
            variant_id: item.variant_id,
            error: "バリアントGraphQLエラー",
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
            error: "バリアントが見つかりません",
            errorType: "logic",
            failedStep: step,
          });
          continue;
        }

        console.log("バリアント情報:", {
          id: variant.id,
          title: variant.product.title,
          inventoryQuantity: variant.inventoryQuantity,
          tracked: variant.inventoryItem.tracked
        });

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

        // 2. 在庫追跡が無効の場合は有効にする
        if (!variant.inventoryItem.tracked) {
          step = "inventoryItemUpdate";
          console.log(`在庫追跡を有効化: ${item.variant_id}`);
          
          const enableTrackingMutation = `
            mutation($input: InventoryItemInput!) {
              inventoryItemUpdate(input: $input) {
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
            input: {
              id: inventoryItemId,
              tracked: true
            }
          };
          
          console.log("在庫追跡有効化変数:", JSON.stringify(trackingVariables, null, 2));
          
          const trackingResult = await admin.graphql(enableTrackingMutation, {
            variables: trackingVariables
          });
          
          const trackingData = await trackingResult.json() as { data?: any; errors?: any };
          logGraphQLResponse("在庫追跡有効化", trackingData, trackingVariables);
          
          const trackingErrorCheck = hasErrors(trackingData);
          if (trackingErrorCheck.hasGraphQLErrors) {
            results.push({
              variant_id: item.variant_id,
              error: "在庫追跡有効化GraphQLエラー",
              errorType: "graphql",
              failedStep: step,
              graphqlErrors: trackingData.errors,
            });
            continue;
          }
          if (trackingErrorCheck.hasUserErrors) {
            results.push({
              variant_id: item.variant_id,
              error: "在庫追跡有効化userError",
              errorType: "userError",
              failedStep: step,
              errors: trackingErrorCheck.userErrors,
            });
            continue;
          }
        }

        // 3. バリアントの在庫管理設定を更新
        if (!variant.inventoryItem.tracked) {
          console.log(`在庫管理をShopifyに設定: ${item.variant_id}`);
          step = "productVariantUpdate";
          const variantUpdateMutation = `
            mutation($input: ProductVariantInput!) {
              productVariantUpdate(input: $input) {
                productVariant {
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
            input: {
              id: item.variant_id,
              inventoryPolicy: 'DENY' // 在庫切れ時は販売停止
            }
          };
          
          console.log("バリアント更新変数:", JSON.stringify(variantUpdateVariables, null, 2));
          
          const variantUpdateResult = await admin.graphql(variantUpdateMutation, {
            variables: variantUpdateVariables
          });
          
          const variantUpdateData = await variantUpdateResult.json() as { data?: any; errors?: any };
          logGraphQLResponse("バリアント更新", variantUpdateData, variantUpdateVariables);
          
          const variantUpdateErrorCheck = hasErrors(variantUpdateData);
          if (variantUpdateErrorCheck.hasGraphQLErrors) {
            results.push({
              variant_id: item.variant_id,
              error: "バリアント更新GraphQLエラー",
              errorType: "graphql",
              failedStep: step,
              graphqlErrors: variantUpdateData.errors,
            });
            continue;
          }
          if (variantUpdateErrorCheck.hasUserErrors) {
            results.push({
              variant_id: item.variant_id,
              error: "バリアント更新userError",
              errorType: "userError",
              failedStep: step,
              errors: variantUpdateErrorCheck.userErrors,
            });
            continue;
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
          console.log("=== 戦略1: inventoryAdjustQuantities (安定版) ===");
          
          const adjMutation = `
            mutation($input: InventoryAdjustQuantitiesInput!) {
              inventoryAdjustQuantities(input: $input) {
                inventoryLevels {
                  available
                  location {
                    name
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
              inventoryItemAdjustments: [
                {
                  inventoryItemId: inventoryItemId,
                  availableDelta: item.quantity
                }
              ],
              locationId: locationId
            }
          };
          
          console.log("戦略1 変数:", JSON.stringify(mutationVariables, null, 2));
          
          const adjResult = await admin.graphql(adjMutation, {
            variables: mutationVariables
          });
          
          adjData = await adjResult.json() as { data?: any; errors?: any };
          logGraphQLResponse("戦略1: inventoryAdjustQuantities", adjData, mutationVariables);
          
          const strategy1ErrorCheck = hasErrors(adjData);
          if (strategy1ErrorCheck.hasGraphQLErrors) {
            adjGraphqlErrors = adjData.errors;
            console.error("戦略1 GraphQLエラー - 次の戦略を試行");
          } else if (!strategy1ErrorCheck.hasUserErrors) {
            success = true;
            usedStrategy = "inventoryAdjustQuantities";
            console.log("戦略1 成功");
          } else {
            adjUserErrors = strategy1ErrorCheck.userErrors;
            console.error("戦略1 userErrors - 次の戦略を試行");
          }
          
        } catch (strategy1Error) {
          adjUserErrors = [{ message: String(strategy1Error) }];
          console.log("戦略1 例外:", strategy1Error);
        }
        
        // 戦略2: inventoryAdjustQuantity (単数形) - より安定したAPI
        if (!success) {
          step = "inventoryAdjustQuantity";
          try {
            console.log("=== 戦略2: inventoryAdjustQuantity (単数形) ===");
            
            // 正確なInventoryLevel IDを取得
            const inventoryLevelQuery = `
              query($inventoryItemIds: [ID!]!, $locationIds: [ID!]!) {
                inventoryLevels(inventoryItemIds: $inventoryItemIds, locationIds: $locationIds) {
                  id
                  available
                }
              }
            `;
            
            const levelQueryVariables = {
              inventoryItemIds: [inventoryItemId],
              locationIds: [locationId]
            };
            
            console.log("InventoryLevel取得変数:", JSON.stringify(levelQueryVariables, null, 2));
            
            const levelResult = await admin.graphql(inventoryLevelQuery, {
              variables: levelQueryVariables
            });
            
            const levelData = await levelResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("InventoryLevel取得", levelData, levelQueryVariables);
            
            const levelErrorCheck = hasErrors(levelData);
            if (levelErrorCheck.hasGraphQLErrors || levelErrorCheck.hasUserErrors) {
              console.error("InventoryLevel取得エラー - 戦略2をスキップ");
              throw new Error("InventoryLevel取得に失敗");
            }
            
            const inventoryLevels = levelData.data?.inventoryLevels;
            let inventoryLevelId: string | undefined;
            if (!inventoryLevels || inventoryLevels.length === 0) {
              // inventoryActivateで自動紐付けを試みる
              console.log("InventoryLevelが未作成。inventoryActivateで初期化を試みます。");
              const activateMutation = `
                mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
                  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
                    inventoryLevel {
                      id
                      available
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
                  error: "Inventory level activation succeeded but no inventoryLevel ID returned.",
                  errorType: "inventoryLevelActivateNoId",
                  failedStep: step,
                });
                continue;
              }
              console.log("inventoryActivateで作成したInventoryLevel ID:", inventoryLevelId);
            } else {
              inventoryLevelId = inventoryLevels[0].id;
              console.log("取得したInventoryLevel ID:", inventoryLevelId);
              console.log("現在の在庫数:", inventoryLevels[0].available);
            }
            // adjustQuantityMutation以下の処理でinventoryLevelIdを使う
            const adjustQuantityMutation = `
              mutation($input: InventoryAdjustQuantityInput!) {
                inventoryAdjustQuantity(input: $input) {
                  inventoryLevel {
                    id
                    available
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
            console.log("戦略2 変数:", JSON.stringify(adjustQuantityVariables, null, 2));
            const adjustResult = await admin.graphql(adjustQuantityMutation, {
              variables: adjustQuantityVariables
            });
            adjData = await adjustResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("戦略2: inventoryAdjustQuantity", adjData, adjustQuantityVariables);
            const strategy2ErrorCheck = hasErrors(adjData);
            if (strategy2ErrorCheck.hasGraphQLErrors) {
              adjGraphqlErrors = adjData.errors;
              console.error("戦略2 GraphQLエラー - 次の戦略を試行");
            } else if (!strategy2ErrorCheck.hasUserErrors) {
              success = true;
              usedStrategy = "inventoryAdjustQuantity";
              console.log("戦略2 成功");
            } else {
              adjUserErrors = strategy2ErrorCheck.userErrors;
              console.error("戦略2 userErrors - 次の戦略を試行");
            }
          } catch (strategy2Error) {
            adjUserErrors = [{ message: String(strategy2Error) }];
            console.log("戦略2 例外:", strategy2Error);
          }
        }
        
        // 戦略3: inventorySetQuantities (フォールバック)
        if (!success) {
          step = "inventorySetQuantities";
          try {
            console.log("=== 戦略3: inventorySetQuantities ===");
            
            // 現在の在庫量を取得
            const currentQuantity = Number(variant.inventoryQuantity) || 0;
            const delta = Number(item.quantity) || 0;
            const newQuantity = Math.max(0, currentQuantity + delta);
            console.log("在庫計算:", {
              currentQuantity,
              delta,
              newQuantity
            });
            
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
            
            console.log("戦略3 変数:", JSON.stringify(setQuantitiesVariables, null, 2));
            
            const setResult = await admin.graphql(setQuantitiesMutation, {
              variables: setQuantitiesVariables
            });
            
            adjData = await setResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("戦略3: inventorySetQuantities", adjData, setQuantitiesVariables);
            
            const strategy3ErrorCheck = hasErrors(adjData);
            if (strategy3ErrorCheck.hasGraphQLErrors) {
              adjGraphqlErrors = adjData.errors;
              console.error("戦略3 GraphQLエラー - 全ての戦略が失敗");
            } else if (!strategy3ErrorCheck.hasUserErrors) {
              success = true;
              usedStrategy = "inventorySetQuantities";
              console.log("戦略3 成功");
            } else {
              adjUserErrors = strategy3ErrorCheck.userErrors;
              console.error("戦略3 userErrors - 全ての戦略が失敗");
            }
            
          } catch (strategy3Error) {
            adjUserErrors = [{ message: String(strategy3Error) }];
            console.log("戦略3 例外:", strategy3Error);
          }
        }
        
        // 戦略4: inventoryAdjustQuantities (最後の手段)
        if (!success) {
          step = "inventoryAdjustQuantities";
          try {
            console.log("=== 戦略4: inventoryAdjustQuantities (最後の手段) ===");
            
            const bulkAdjustMutation = `
              mutation($input: InventoryAdjustQuantitiesInput!) {
                inventoryAdjustQuantities(input: $input) {
                  inventoryLevels {
                    id
                    available
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
                inventoryItemAdjustments: [
                  {
                    inventoryItemId: inventoryItemId,
                    availableDelta: item.quantity
                  }
                ],
                locationId: locationId
              }
            };
            
            console.log("戦略4 変数:", JSON.stringify(bulkAdjustVariables, null, 2));
            
            const bulkResult = await admin.graphql(bulkAdjustMutation, {
              variables: bulkAdjustVariables
            });
            
            adjData = await bulkResult.json() as { data?: any; errors?: any };
            logGraphQLResponse("戦略4: inventoryAdjustQuantities", adjData, bulkAdjustVariables);
            
            const strategy4ErrorCheck = hasErrors(adjData);
            if (strategy4ErrorCheck.hasGraphQLErrors) {
              adjGraphqlErrors = adjData.errors;
              console.error("戦略4 GraphQLエラー - 全ての戦略が失敗");
            } else if (!strategy4ErrorCheck.hasUserErrors) {
              success = true;
              usedStrategy = "inventoryAdjustQuantities";
              console.log("戦略4 成功");
            } else {
              adjUserErrors = strategy4ErrorCheck.userErrors;
              console.error("戦略4 userErrors - 全ての戦略が失敗");
            }
            
          } catch (strategy4Error) {
            adjUserErrors = [{ message: String(strategy4Error) }];
            console.log("戦略4 例外:", strategy4Error);
          }
        }
        
        // 戦略1・2ともに失敗した場合のみエラー記録
        if (success) {
          console.log(`バリアント ${item.variant_id} 処理成功: ${usedStrategy}`);
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
                     adjData?.data?.inventoryBulkAdjustQuantityAtLocation?.inventoryLevels,
            errors: [],
            strategy_used: usedStrategy,
          });
        } else {
          console.error(`バリアント ${item.variant_id} 処理失敗:`, {
            errorType: adjGraphqlErrors ? "graphql" : (adjUserErrors.length ? "userError" : "unknown"),
            failedStep: step,
            userErrors: adjUserErrors,
            graphqlErrors: adjGraphqlErrors
          });
          
          // 失敗詳細を記録
          results.push({
            variant_id: item.variant_id,
            error: "在庫調整に失敗しました",
            errorType: adjGraphqlErrors ? "graphql" : (adjUserErrors.length ? "userError" : "unknown"),
            failedStep: step,
            errors: adjUserErrors,
            graphqlErrors: adjGraphqlErrors,
            strategy_used: usedStrategy || step,
          });
        }
      } catch (itemError) {
        console.error(`バリアント ${item.variant_id} 例外エラー:`, itemError);
        results.push({
          variant_id: item.variant_id,
          error: itemError instanceof Error ? itemError.message : String(itemError),
          errorType: "exception",
          failedStep: step,
        });
      }
    }
    
    console.log("同期処理完了:", {
      totalItems: items.length,
      results: results.map(r => ({
        variant_id: r.variant_id,
        success: !r.error,
        error: r.error,
        strategy: r.strategy_used
      }))
    });
    
    return json({ results });
  } catch (error) {
    console.error("同期処理全体エラー:", error);
    return json({ 
      error: error instanceof Error ? error.message : String(error),
      debug: error instanceof Error ? error.stack : undefined
    }, { status: 500 });
  }
}; 