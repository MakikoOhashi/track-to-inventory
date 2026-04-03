import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

// /api/shopify/products?title=xxxx
export const loader = async ({ request }: LoaderFunctionArgs ) => {
    console.log("API HIT", request.url);
    const url = new URL(request.url);
  const title = url.searchParams.get("title") || "";
  if (!title) return json({ products: [] });

  const { admin } = await authenticate.admin(request);

  // GraphQLで商品検索
  const resp = await admin.graphql(
    `#graphql
      query Products($query: String!) {
        products(first: 10, query: $query) {
          edges {
            node {
              id
              title
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { query: `title:${title}` } }
  );

  // レスポンスをJSONとしてパース
  const data = await resp.json();

  // 必要なデータ整形
  const products =
    data.data?.products?.edges?.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      variants:
        edge.node.variants.edges.map((v: any) => ({
          id: v.node.id,
          title: v.node.title,
          sku: v.node.sku,
        })) || [],
    })) || [];

  return json({ products });
};