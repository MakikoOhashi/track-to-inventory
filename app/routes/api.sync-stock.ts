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
      // バリアントIDからinventory_item_id取得
      const variantQuery = `
        query($id: ID!) {
          productVariant(id: $id) {
            inventoryItem { id }
          }
        }
      `;
      const variantRes = await admin.graphql(variantQuery, { variables: { id: item.variant_id } });
      
      // ✅ 修正：GraphQLレスポンスを正しく処理
      const variantData = await variantRes.json();
      
      const inventoryItemId = variantData.data?.productVariant?.inventoryItem?.id;
      if (!inventoryItemId) {
        results.push({
          variant_id: item.variant_id,
          error: "inventory_item_idが取得できませんでした"
        });
        continue;
      }
      
      // 在庫を追加
      const adjMutation = `
        mutation($inventoryItemId: ID!, $locationId: ID!, $availableDelta: Int!) {
          inventoryAdjustQuantity(
            input: { inventoryItemId: $inventoryItemId, locationId: $locationId, availableDelta: $availableDelta }
          ) {
            inventoryLevel { id available }
            userErrors { field message }
          }
        }
      `;
      const adjResult = await admin.graphql(adjMutation, {
        variables: {
          inventoryItemId,
          locationId,
          availableDelta: item.quantity,
        }
      });
      
      // ✅ 修正：GraphQLレスポンスを正しく処理
      const adjData = await adjResult.json();
      
      const errors = adjData.data?.inventoryAdjustQuantity?.userErrors || [];
      results.push({
        variant_id: item.variant_id,
        response: adjData.data?.inventoryAdjustQuantity?.inventoryLevel,
        errors,
      });
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