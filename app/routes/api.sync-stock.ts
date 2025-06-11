import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

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

    const results = [];
    for (const item of items) {
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
        const variantData = await variantRes.json();
        
        const variant = variantData.data?.productVariant;
        if (!variant) {
          results.push({
            variant_id: item.variant_id,
            error: "バリアントが見つかりません"
          });
          continue;
        }

        const inventoryItemId = variant.inventoryItem?.id;
        if (!inventoryItemId) {
          results.push({
            variant_id: item.variant_id,
            error: "inventory_item_idが取得できませんでした"
          });
          continue;
        }

        // 2. 在庫追跡が無効の場合は有効にする
        if (!variant.inventoryItem.tracked) {
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
          
          const trackingData = await trackingResult.json();
          if (trackingData.data?.inventoryItemUpdate?.userErrors?.length > 0) {
            console.error("在庫追跡有効化エラー:", trackingData.data.inventoryItemUpdate.userErrors);
          }
        }

        // 3. バリアントの在庫管理設定を更新
        if (!variant.inventoryItem.tracked) {
          console.log(`在庫管理をShopifyに設定: ${item.variant_id}`);
          
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
          
          const variantUpdateData = await variantUpdateResult.json();
          if (variantUpdateData.data?.productVariantUpdate?.userErrors?.length > 0) {
            console.error("バリアント更新エラー:", variantUpdateData.data.productVariantUpdate.userErrors);
          }
        }

        // 4. 在庫数量を調整 - ✅ 修正された部分
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
        
        // デバッグ用：mutation変数をログ出力
        const mutationVariables = {
          input: {
            reason: "correction",
            // name: "在庫同期",
            changes: [
              {
                delta: item.quantity,
                inventoryItemId: inventoryItemId,
                locationId: locationId,
                // name: "available"
              }
            ]
          }
        };
        
        console.log("Mutation variables:", JSON.stringify(mutationVariables, null, 2));
        
        console.log("adjMutation クエリ内容:", adjMutation);

// 元のコード（129行目あたり）を削除
// const adjResult = await admin.graphql(adjMutation, {
//   variables: mutationVariables
// });

// ↓ これに置き換え
let adjResult;
let adjData;

try {
  console.log("=== GraphQL実行直前デバッグ ===");
  console.log("Query:", adjMutation);
  console.log("Variables:", JSON.stringify(mutationVariables, null, 2));
  console.log("================================");
  
  adjResult = await admin.graphql(adjMutation, {
    variables: mutationVariables
  });
  
  adjData = await adjResult.json();
  console.log("=== GraphQL実行成功 ===");
  console.log("Response:", JSON.stringify(adjData, null, 2));
  
} catch (error) {
  console.log("=== DETAILED ERROR DEBUG ===");
  console.log("Error Type:", typeof error);
  console.log("Error instanceof Error:", error instanceof Error);
  
  // 型ガード：Errorオブジェクトかチェック
  if (error instanceof Error) {
    console.log("Error Message:", error.message);
    console.log("Error Name:", error.name);
    console.log("Error Stack:", error.stack);
  }
  
  // 型ガード：GraphQLエラーがある場合（重要！）
  if (error && typeof error === 'object' && 'graphQLErrors' in error) {
    console.log("=== GraphQL Errors 詳細 ===");
    const graphQLErrors = (error as any).graphQLErrors;
    console.log("GraphQL Errors Length:", graphQLErrors?.length);
    
    // 配列の中身を一つずつ出力
    if (Array.isArray(graphQLErrors)) {
      graphQLErrors.forEach((gqlError: any, index: number) => {
        console.log(`--- GraphQL Error ${index + 1} ---`);
        console.log("Message:", gqlError?.message);
        console.log("Path:", gqlError?.path);
        console.log("Extensions:", gqlError?.extensions);
        console.log("Locations:", gqlError?.locations);
        console.log("Raw Error:", gqlError);
      });
    }
  }
  
  // ネットワークステータス
  if (error && typeof error === 'object' && 'networkStatusCode' in error) {
    console.log("Network Status Code:", (error as any).networkStatusCode);
  }
  
  // レスポンス詳細
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as any).response;
    console.log("Response Status:", response?.status);
    console.log("Response StatusText:", response?.statusText);
  }
  
  // 元のエラーオブジェクト全体も確認用に出力
  console.log("Full Error Object:", JSON.stringify(error, null, 2));
  
  console.log("========================");
  throw error;
}
// GraphQLのトップレベルエラー（多くの場合はこの形式）
if ((adjData as any).errors) {
  console.error("GraphQL errors (adjData.errors):", JSON.stringify((adjData as any).errors, null, 2));
}

// まれに graphQLErrors というプロパティで返る場合もある
if ((adjData as any).graphQLErrors) {
  console.error("GraphQL errors (adjData.graphQLErrors):", JSON.stringify((adjData as any).graphQLErrors, null, 2));
}

        // mutationの中のuserErrors
        const userErrors = adjData.data?.inventoryAdjustQuantities?.userErrors || [];
        if (userErrors.length > 0) {
          console.error("User errors:", JSON.stringify(userErrors, null, 2));
        }
        
        const errors = adjData.data?.inventoryAdjustQuantities?.userErrors || [];
        
        
        results.push({
          variant_id: item.variant_id,
          product_title: variant.product.title,
          before_quantity: variant.inventoryQuantity,
          delta: item.quantity,
          after_quantity: variant.inventoryQuantity + item.quantity,
          tracking_enabled: variant.inventoryItem.tracked,
          response: adjData.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup,
          errors,
        });
        console.log("adjData:", JSON.stringify(adjData, null, 2));

      } catch (itemError) {
        console.error(`アイテム処理エラー (${item.variant_id}):`, itemError);
        results.push({
          variant_id: item.variant_id,
          error: itemError instanceof Error ? itemError.message : String(itemError)
        });
      }
    }
    
    return json({ results });
    
  } catch (error) {
    console.error("sync-stock エラー詳細:", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : undefined
    });
    return json({ 
      error: error instanceof Error ? error.message : String(error),
      debug: error instanceof Error ? error.stack : undefined
    }, { status: 500 });
  }
};