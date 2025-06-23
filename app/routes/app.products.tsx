import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "~/shopify.server";

type LoaderData = {
  products: Array<{
    id: string;
    title: string;
    variants: Array<{
      id: string;
      title: string;
      sku: string | null;
      selectedOptions: Array<{
        name: string;
        value: string;
      }>;
    }>;
  }>;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log('🚀 app.products loader: Starting...');
  
  try {
    const { admin } = await authenticate.admin(request);
    console.log('✅ app.products loader: Authentication successful');
    
    // Shopify GraphQLで商品とバリアントを取得
    const query = `
      query ProductsWithVariants($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    sku
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const variables = { first: 50 };
    
    console.log('📡 app.products loader: Sending GraphQL request...');
    const response = await admin.graphql(query, { variables });
    const data = await response.json() as any;
    
    console.log('📊 app.products loader: GraphQL response received');
    
    // エラー処理
    if (data.errors) {
      console.error("❌ app.products loader: GraphQL Errors:", data.errors);
      throw new Error(data.errors.map((e: any) => e.message).join(', '));
    }

    // データ存在チェック
    if (!data.data || !data.data.products) {
      console.error("❌ app.products loader: No products found in response");
      throw new Error("No products found in response");
    }

    // 整形して返す
    const products = (data.data.products.edges || []).map(({ node }: any) => ({
      id: node.id,
      title: node.title,
      variants: (node.variants.edges || []).map(({ node: v }: any) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        selectedOptions: v.selectedOptions || [],
      })),
    }));

    console.log(`✅ app.products loader: Successfully processed ${products.length} products`);
    return json<LoaderData>({ products });
  } catch (error) {
    console.error("❌ app.products loader: Failed to fetch products:", error);
    return json<LoaderData>({ 
      products: [],
      error: error instanceof Error ? error.message : "Failed to fetch products"
    });
  }
};

export default function ProductsRoute() {
  const { products, error } = useLoaderData<typeof loader>();
  
  // このrouteはデータ提供専用なので、UIは表示しない
  return null;
} 