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
    
    // ❌ これが問題！ReadableStreamを含むオブジェクト全体をログ出力
    // console.log("Location取得結果 (全体):", locationResult);
    
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
              inventoryManagement
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
        if (variant.inventoryManagement !== 'SHOPIFY') {
          console.log(`在庫管理をShopifyに設定: ${item.variant_id}`);
          
          const variantUpdateMutation = `
            mutation($input: ProductVariantInput!) {
              productVariantUpdate(input: $input) {
                productVariant {
                  id
                  inventoryManagement
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
                inventoryManagement: 'SHOPIFY',
                inventoryPolicy: 'DENY' // 在庫切れ時は販売停止
              }
            }
          });
          
          const variantUpdateData = await variantUpdateResult.json();
          if (variantUpdateData.data?.productVariantUpdate?.userErrors?.length > 0) {
            console.error("バリアント更新エラー:", variantUpdateData.data.productVariantUpdate.userErrors);
          }
        }

        // 4. 在庫数量を調整
        const adjMutation = `
          mutation($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
              inventoryAdjustmentGroup {
                reason
                referenceDocumentUri
                changes {
                  name
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
        
        const adjResult = await admin.graphql(adjMutation, {
          variables: {
            input: {
              reason: "correction",
              name: "在庫同期",
              changes: [
                {
                  delta: item.quantity,
                  inventoryItemId: inventoryItemId,
                  locationId: locationId
                }
              ]
            }
          }
        });
        
        const adjData = await adjResult.json();
        const errors = adjData.data?.inventoryAdjustQuantities?.userErrors || [];
        
        results.push({
          variant_id: item.variant_id,
          product_title: variant.product.title,
          before_quantity: variant.inventoryQuantity,
          delta: item.quantity,
          after_quantity: variant.inventoryQuantity + item.quantity,
          tracking_enabled: variant.inventoryItem.tracked,
          inventory_management: variant.inventoryManagement,
          response: adjData.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup,
          errors,
        });

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