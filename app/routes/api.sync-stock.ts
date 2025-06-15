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
  errorType?: string;    // 追加: エラータイプ（userError, graphql, logic, exception など）
  failedStep?: string;   // 追加: どの処理で失敗したか
  graphqlErrors?: unknown; // GraphQLトップレベルのerrors
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { items } = await request.json();
    if (!items || items.length === 0) {
      return json({ error: "同期する商品がありません" }, { status: 400 });
    }

    // まず、ストアのLocation IDを動的に取得
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
    
    // ✅ 修正：GraphQLレスポンスを正しく処理
    const locationData = await locationResult.json();
    console.log("Location取得結果:", locationData);
    
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
        
        const variantRes = await admin.graphql(variantQuery, { 
          variables: { id: item.variant_id } 
        });
        const variantData = await variantRes.json() as { data?: any; errors?: any };
        
        if (variantData.errors) {
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
          
          const trackingResult = await admin.graphql(enableTrackingMutation, {
            variables: {
              input: {
                id: inventoryItemId,
                tracked: true
              }
            }
          });
          
          const trackingData = await trackingResult.json() as { data?: any; errors?: any };
          if (trackingData.errors) {
            results.push({
              variant_id: item.variant_id,
              error: "在庫追跡有効化GraphQLエラー",
              errorType: "graphql",
              failedStep: step,
              graphqlErrors: trackingData.errors,
            });
            continue;
          }
          if (trackingData.data?.inventoryItemUpdate?.userErrors?.length > 0) {
            results.push({
              variant_id: item.variant_id,
              error: "在庫追跡有効化userError",
              errorType: "userError",
              failedStep: step,
              errors: trackingData.data.inventoryItemUpdate.userErrors,
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
          
          const variantUpdateResult = await admin.graphql(variantUpdateMutation, {
            variables: {
              input: {
                id: item.variant_id,
                inventoryPolicy: 'DENY' // 在庫切れ時は販売停止
              }
            }
          });
          
          const variantUpdateData = await variantUpdateResult.json() as { data?: any; errors?: any };
          if (variantUpdateData.errors) {
            results.push({
              variant_id: item.variant_id,
              error: "バリアント更新GraphQLエラー",
              errorType: "graphql",
              failedStep: step,
              graphqlErrors: variantUpdateData.errors,
            });
            continue;
          }
          if (variantUpdateData.data?.productVariantUpdate?.userErrors?.length > 0) {
            results.push({
              variant_id: item.variant_id,
              error: "バリアント更新userError",
              errorType: "userError",
              failedStep: step,
              errors: variantUpdateData.data.productVariantUpdate.userErrors,
            });
            continue;
          }
        }

        // 4. 在庫数量を調整 - ✅ 修正された部分（nameフィールド追加 + フォールバック戦略）
        let adjData: any = null;
        let success = false;
        let adjUserErrors: UserError[] = [];
        let adjGraphqlErrors: unknown = undefined;
        let usedStrategy = "";
        
        // 戦略1: inventoryAdjustQuantities with name field
        step = "inventoryAdjustQuantities";
        try {
          console.log("=== 戦略1: inventoryAdjustQuantities (name追加) ===");
          
          const adjMutation = `
            mutation($input: InventoryAdjustQuantitiesInput!) {
              inventoryAdjustQuantities(input: $input) {
                inventoryAdjustmentGroup {
                  reason
                  referenceDocumentUri
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
          
          // ✅ nameフィールドを追加
          const mutationVariables = {
            input: {
              reason: "correction",
              name: "available", // ✅ 新たに必須となったフィールド
              changes: [
                {
                  delta: item.quantity,
                  inventoryItemId: inventoryItemId,
                  locationId: locationId
                }
              ]
            }
          };
          
          console.log("Variables with name field:", JSON.stringify(mutationVariables, null, 2));
          
          const adjResult = await admin.graphql(adjMutation, {
            variables: mutationVariables
          });
          
          adjData = await adjResult.json() as { data?: any; errors?: any };
          console.log("戦略1 成功:", JSON.stringify(adjData, null, 2));
          
          if (adjData.errors) {
            adjGraphqlErrors = adjData.errors;
          } else if (!adjData.data?.inventoryAdjustQuantities?.userErrors?.length) {
            success = true;
            usedStrategy = "inventoryAdjustQuantities";
          } else {
            adjUserErrors = adjData.data.inventoryAdjustQuantities.userErrors;
          }
          
        } catch (strategy1Error) {
          adjUserErrors = [{ message: String(strategy1Error) }];
          console.log("戦略1 失敗:", strategy1Error);
        }
        
        // 戦略2: inventorySetQuantities (フォールバック)
        if (!success) {
          step = "inventorySetQuantities";
          try {
            console.log("=== 戦略2: inventorySetQuantities ===");
            
            // 現在の在庫量を取得
            const currentQuantity = variant.inventoryQuantity || 0;
            const newQuantity = Math.max(0, currentQuantity + item.quantity);
            
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
                reason: "correction",
                setQuantities: [
                  {
                    inventoryItemId: inventoryItemId,
                    locationId: locationId,
                    quantity: newQuantity
                  }
                ]
              }
            };
            
            console.log("Set quantities variables:", JSON.stringify(setQuantitiesVariables, null, 2));
            
            const setResult = await admin.graphql(setQuantitiesMutation, {
              variables: setQuantitiesVariables
            });
            
            adjData = await setResult.json() as { data?: any; errors?: any };
            console.log("戦略2 成功:", JSON.stringify(adjData, null, 2));
            
            if (adjData.errors) {
              adjGraphqlErrors = adjData.errors;
            } else if (!adjData.data?.inventorySetQuantities?.userErrors?.length) {
              success = true;
              usedStrategy = "inventorySetQuantities";
            } else {
              adjUserErrors = adjData.data.inventorySetQuantities.userErrors;
            }
            
          } catch (strategy2Error) {
            adjUserErrors = [{ message: String(strategy2Error) }];
            console.log("戦略2 失敗:", strategy2Error);
          }
        }
        
        // 戦略3: Legacy inventoryBulkAdjustQuantityAtLocation (最終フォールバック)
        if (!success) {
          step = "inventoryBulkAdjustQuantityAtLocation";
          try {
            console.log("=== 戦略3: Legacy inventoryBulkAdjustQuantityAtLocation ===");
            
            const legacyMutation = `
              mutation inventoryBulkAdjustQuantityAtLocation($inventoryItemAdjustments: [InventoryAdjustItemInput!]!, $locationId: ID!) {
                inventoryBulkAdjustQuantityAtLocation(inventoryItemAdjustments: $inventoryItemAdjustments, locationId: $locationId) {
                  inventoryLevels {
                    available
                    item {
                      id
                    }
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;
            
            const legacyVariables = {
              locationId: locationId,
              inventoryItemAdjustments: [
                {
                  inventoryItemId: inventoryItemId,
                  availableDelta: item.quantity
                }
              ]
            };
            
            console.log("Legacy variables:", JSON.stringify(legacyVariables, null, 2));
            
            const legacyResult = await admin.graphql(legacyMutation, {
              variables: legacyVariables
            });
            
            adjData = await legacyResult.json() as { data?: any; errors?: any };
            console.log("戦略3 成功:", JSON.stringify(adjData, null, 2));
            
            if (adjData.errors) {
              adjGraphqlErrors = adjData.errors;
            } else if (!adjData.data?.inventoryBulkAdjustQuantityAtLocation?.userErrors?.length) {
              success = true;
              usedStrategy = "inventoryBulkAdjustQuantityAtLocation";
            } else {
              adjUserErrors = adjData.data.inventoryBulkAdjustQuantityAtLocation.userErrors;
            }
            
          } catch (strategy3Error) {
            adjUserErrors = [{ message: String(strategy3Error) }];
            console.log("戦略3 失敗:", strategy3Error);
          }
        }
        // 成功時
        if (success) {
          results.push({
            variant_id: item.variant_id,
            product_title: variant.product.title,
            before_quantity: variant.inventoryQuantity,
            delta: item.quantity,
            after_quantity: variant.inventoryQuantity + item.quantity,
            tracking_enabled: variant.inventoryItem.tracked,
            response: adjData?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup || 
                     adjData?.data?.inventorySetQuantities?.inventoryAdjustmentGroup ||
                     adjData?.data?.inventoryBulkAdjustQuantityAtLocation?.inventoryLevels,
            errors: [],
            strategy_used: usedStrategy,
          });
        } else {
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

//         // エラーハンドリング
//         if (!success || !adjData) {
//           console.error("全ての戦略が失敗しました または adjData が null です");
//           results.push({
//             variant_id: item.variant_id,
//             error: "在庫調整に失敗しました - 全ての戦略が失敗"
//           });
//           continue;
//         }

//         // GraphQLのトップレベルエラーチェック
//         if (adjData && adjData.errors) {
//           console.error("GraphQL errors:", JSON.stringify(adjData.errors, null, 2));
//         }

//         // userErrorsチェック（各戦略に応じて）
//         let userErrors: UserError[] = [];
//         if (adjData?.data?.inventoryAdjustQuantities?.userErrors) {
//           userErrors = adjData.data.inventoryAdjustQuantities.userErrors;
//         } else if (adjData?.data?.inventorySetQuantities?.userErrors) {
//           userErrors = adjData.data.inventorySetQuantities.userErrors;
//         } else if (adjData?.data?.inventoryBulkAdjustQuantityAtLocation?.userErrors) {
//           userErrors = adjData.data.inventoryBulkAdjustQuantityAtLocation.userErrors;
//         }
        
//         if (userErrors.length > 0) {
//           console.error("User errors:", JSON.stringify(userErrors, null, 2));
//         }
        
//         results.push({
//           variant_id: item.variant_id,
//           product_title: variant.product.title,
//           before_quantity: variant.inventoryQuantity,
//           delta: item.quantity,
//           after_quantity: variant.inventoryQuantity + item.quantity,
//           tracking_enabled: variant.inventoryItem.tracked,
//           response: adjData?.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup || 
//                    adjData?.data?.inventorySetQuantities?.inventoryAdjustmentGroup ||
//                    adjData?.data?.inventoryBulkAdjustQuantityAtLocation?.inventoryLevels,
//           errors: userErrors,
//           strategy_used: success ? "success" : "failed"
//         });

//         console.log(`在庫調整完了 - ${item.variant_id}:`, adjData ? JSON.stringify(adjData, null, 2) : "adjData is null");

//       } catch (itemError) {
//         console.error(`アイテム処理エラー (${item.variant_id}):`, itemError);
//         results.push({
//           variant_id: item.variant_id,
//           error: itemError instanceof Error ? itemError.message : String(itemError)
//         });
//       }
//     }
    
//     return json({ results });
    
//   } catch (error) {
//     console.error("sync-stock エラー詳細:", {
//       message: error instanceof Error ? error.message : String(error),
//       stack: error instanceof Error ? error.stack : undefined,
//       name: error instanceof Error ? error.name : undefined
//     });
//     return json({ 
//       error: error instanceof Error ? error.message : String(error),
//       debug: error instanceof Error ? error.stack : undefined
//     }, { status: 500 });
//   }
// };