import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID!;

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { items } = await request.json();
    if (!items || items.length === 0) {
      return json({ error: "同期する商品がありません" }, { status: 400 });
    }
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
      const variantRes = await admin.graphql(variantQuery, { variables: { id: item.variant_id } }) as any;
      const inventoryItemId = variantRes.data.productVariant?.inventoryItem?.id;
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
          locationId: SHOPIFY_LOCATION_ID,
          availableDelta: item.quantity,
        }
      }) as any;
      const errors = adjResult.data.inventoryAdjustQuantity?.userErrors || [];
      results.push({
        variant_id: item.variant_id,
        response: adjResult.data.inventoryAdjustQuantity.inventoryLevel,
        errors,
      });
    }
    return json({ results });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
};