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
  try {
    const { admin } = await authenticate.admin(request);
    
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
    
    const response = await admin.graphql(query, { variables });
    const data = await response.json() as any;
    
    // エラー処理
    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      throw new Error(data.errors.map((e: any) => e.message).join(', '));
    }

    // データ存在チェック
    if (!data.data || !data.data.products) {
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

    return json<LoaderData>({ products });
  } catch (error) {
    console.error("Failed to fetch products:", error);
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