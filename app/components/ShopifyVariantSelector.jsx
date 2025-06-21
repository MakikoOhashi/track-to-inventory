import React, { useState, useEffect } from 'react';
import { Select, Spinner, Button, Text } from '@shopify/polaris';
import { useTranslation } from 'react-i18next';

// GraphQLで商品とバリアントを取得するAPI呼び出し（デバッグ版）
async function fetchProductsWithVariants() {
  try {
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
    
    console.log("Sending GraphQL request...");
    
    const res = await fetch("/api/shopify/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    console.log("Response status:", res.status);
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error("HTTP Error:", res.status, errorText);
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const json = await res.json();
    console.log("GraphQL Response:", json);

    // エラー処理
    if (json.errors) {
      console.error("GraphQL Errors:", json.errors);
      throw new Error(json.errors.map(e => e.message).join(', '));
    }

    // データ存在チェック
    if (!json.data) {
      console.error("No data in response:", json);
      throw new Error("No data received from GraphQL");
    }

    if (!json.data.products) {
      console.error("No products in data:", json.data);
      throw new Error("No products found in response");
    }

    // 整形して返す
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

    console.log("Processed products:", products.length);
    return products;
    
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error; // エラーを再スローして呼び出し元で処理
  }
}

const ShopifyVariantSelector = ({ value, onChange, initialProductId = "" }) => {
  const { t } = useTranslation();
  const [allProducts, setAllProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

  const [selectedProductId, setSelectedProductId] = useState(initialProductId);
  const [variantOptions, setVariantOptions] = useState([]);
  const [selectedVariantId, setSelectedVariantId] = useState(value || "");
  const [apiError, setApiError] = useState("");

  useEffect(() => {
    setLoadingProducts(true);
    fetchProductsWithVariants()
      .then(products => {
        setAllProducts(products);
        setLoadingProducts(false);
        setApiError("");
      })
      .catch(e => {
        setAllProducts([]);
        setLoadingProducts(false);
        setApiError(t('shopifyVariantSelector.fetchError', { message: e.message }));
      });
  }, [t]);

  useEffect(() => {
    if (!selectedProductId) {
      setVariantOptions([]);
      setSelectedVariantId("");
      return;
    }
    const product = allProducts.find((p) => p.id === selectedProductId);
    if (product && product.variants) {
      setVariantOptions(product.variants.map((v) => ({
        label: `${v.title}（SKU: ${v.sku || '-' }）` + 
          (v.selectedOptions && v.selectedOptions.length
            ? ` / ${v.selectedOptions.map(opt => `${opt.name}:${opt.value}`).join(', ')}`
            : ''),
        value: v.id,
        variant: v,
      })));
    } else {
      setVariantOptions([]);
    }
    setSelectedVariantId("");
  }, [selectedProductId, allProducts]);

  useEffect(() => {
    if (!selectedVariantId) return;
    const product = allProducts.find((p) => p.id === selectedProductId);
    const variant = variantOptions.find((v) => v.value === selectedVariantId)?.variant;
    if (product && variant) {
      onChange?.(selectedVariantId, { product, variant });
    }
  }, [selectedVariantId]);

  return (
    <div>
      <Text variant="headingSm">{t('shopifyVariantSelector.title')}</Text>
      {apiError && <Text tone="critical">{apiError}</Text>}
      {loadingProducts ? (
        <Spinner accessibilityLabel={t('shopifyVariantSelector.loadingProducts')} size="small" />
      ) : (
        <>
          <Select
            label={t('shopifyVariantSelector.productSelectLabel')}
            options={[
              { label: t('shopifyVariantSelector.pleaseSelect'), value: "" },
              ...allProducts.map((p) => ({
                label: p.title,
                value: p.id,
              })),
            ]}
            value={selectedProductId}
            onChange={(value) => setSelectedProductId(value)}
          />
          {variantOptions.length > 0 && (
            <Select
              label={t('shopifyVariantSelector.variantSelectLabel')}
              options={[
                { label: t('shopifyVariantSelector.pleaseSelect'), value: "" },
                ...variantOptions.map((v) => ({
                  label: v.label,
                  value: v.value,
                })),
              ]}
              value={selectedVariantId}
              onChange={(value) => setSelectedVariantId(value)}
              disabled={!selectedProductId}
            />
          )}
          {(selectedProductId || selectedVariantId) && (
            <Button
              size="slim"
              onClick={() => {
                setSelectedProductId("");
                setVariantOptions([]);
                setSelectedVariantId("");
                onChange?.("", {});
              }}
              style={{ marginTop: 4 }}
            >
              {t('shopifyVariantSelector.clearSelection')}
            </Button>
          )}
        </>
      )}
      {selectedVariantId && (
        <Text variant="bodySm" tone="subdued">
          {t('shopifyVariantSelector.selectedVariantId', { variantId: selectedVariantId })}
        </Text>
      )}
    </div>
  );
};

export default ShopifyVariantSelector;