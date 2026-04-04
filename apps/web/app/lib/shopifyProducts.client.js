let productsCache = null;
let productsPromise = null;

function getShopIdFromLocation() {
  if (typeof window === "undefined") return "";
  const params = new URL(window.location.href).searchParams;
  return params.get("shop_id") || params.get("shop") || "";
}

export function getShopifyProductsCache() {
  return productsCache;
}

export async function fetchProductsWithVariants() {
  if (productsCache) {
    return productsCache;
  }

  if (productsPromise) {
    return productsPromise;
  }

  const loadPromise = (async () => {
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
    const shopId = getShopIdFromLocation();
    const queryParams = shopId ? `?shop_id=${encodeURIComponent(shopId)}` : "";

    const res = await fetch(`/api/shopify/graphql${queryParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors.map((e) => e.message).join(", "));
    }

    if (!json.data?.products) {
      throw new Error("No products found in response");
    }

    const products = (json.data.products.edges || []).map(({ node }) => ({
      id: node.id,
      title: node.title,
      variants: (node.variants.edges || []).map(({ node: v }) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        selectedOptions: v.selectedOptions || [],
      })),
    }));

    productsCache = products;
    return products;
  })();

  productsPromise = loadPromise.finally(() => {
    productsPromise = null;
  });

  return productsPromise;
}
