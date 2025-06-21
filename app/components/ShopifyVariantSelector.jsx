import React, { useState, useEffect, useCallback } from 'react';
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

  // 商品データ取得をuseCallbackでメモ化
  const loadProducts = useCallback(async () => {
    try {
      setLoadingProducts(true);
      setApiError("");
      const products = await fetchProductsWithVariants();
      setAllProducts(products);
    } catch (error) {
      console.error("Failed to load products:", error);
      setAllProducts([]);
      setApiError(t('shopifyVariantSelector.fetchError', { message: error.message }));
    } finally {
      setLoadingProducts(false);
    }
  }, [t]);

  // 初期化時に商品データを取得
  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // 選択された商品が変更された時の処理
  useEffect(() => {
    if (!selectedProductId) {
      setVariantOptions([]);
      setSelectedVariantId("");
      return;
    }
    
    const product = allProducts.find((p) => p.id === selectedProductId);
    if (product && product.variants) {
      const newVariantOptions = product.variants.map((v) => ({
        label: `${v.title}（SKU: ${v.sku || '-' }）` + 
          (v.selectedOptions && v.selectedOptions.length
            ? ` / ${v.selectedOptions.map(opt => `${opt.name}:${opt.value}`).join(', ')}`
            : ''),
        value: v.id,
        variant: v,
      }));
      setVariantOptions(newVariantOptions);
    } else {
      setVariantOptions([]);
    }
    setSelectedVariantId("");
  }, [selectedProductId, allProducts]);

  // 選択されたバリアントが変更された時の処理
  useEffect(() => {
    if (!selectedVariantId || !onChange) return;
    
    const product = allProducts.find((p) => p.id === selectedProductId);
    const variant = variantOptions.find((v) => v.value === selectedVariantId)?.variant;
    
    if (product && variant) {
      onChange(selectedVariantId, { product, variant });
    }
  }, [selectedVariantId, selectedProductId, allProducts, variantOptions, onChange]);

  // 選択クリア処理
  const handleClearSelection = useCallback(() => {
    setSelectedProductId("");
    setVariantOptions([]);
    setSelectedVariantId("");
    if (onChange) {
      onChange("", {});
    }
  }, [onChange]);

  // 商品選択処理
  const handleProductChange = useCallback((value) => {
    setSelectedProductId(value);
  }, []);

  // バリアント選択処理
  const handleVariantChange = useCallback((value) => {
    setSelectedVariantId(value);
  }, []);

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
            onChange={handleProductChange}
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
              onChange={handleVariantChange}
              disabled={!selectedProductId}
            />
          )}
          {(selectedProductId || selectedVariantId) && (
            <Button
              size="slim"
              onClick={handleClearSelection}
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