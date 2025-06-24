import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Select, Spinner, Button, Text } from '@shopify/polaris';
import { useTranslation } from 'react-i18next';

// GraphQLで商品とバリアントを取得するAPI呼び出し
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
    
    console.log("🔄 ShopifyVariantSelector: Sending GraphQL request...");
    
    const res = await fetch("/api/shopify/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    console.log("📊 ShopifyVariantSelector: Response status:", res.status);
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error("❌ ShopifyVariantSelector: HTTP Error:", res.status, errorText);
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const json = await res.json();
    console.log("📦 ShopifyVariantSelector: GraphQL Response received");

    // エラー処理
    if (json.errors) {
      console.error("❌ ShopifyVariantSelector: GraphQL Errors:", json.errors);
      throw new Error(json.errors.map(e => e.message).join(', '));
    }

    // データ存在チェック
    if (!json.data) {
      console.error("❌ ShopifyVariantSelector: No data in response:", json);
      throw new Error("No data received from GraphQL");
    }

    if (!json.data.products) {
      console.error("❌ ShopifyVariantSelector: No products in data:", json.data);
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

    console.log("✅ ShopifyVariantSelector: Processed", products.length, "products");
    return products;
    
  } catch (error) {
    console.error("❌ ShopifyVariantSelector: Error fetching products:", error);
    throw error;
  }
}

const ShopifyVariantSelector = ({ value, onChange, initialProductId = "" }) => {
  console.log('🚀 ShopifyVariantSelector: Component initialized!', { value, initialProductId });
  console.log('🔍 ShopifyVariantSelector: Props received:', { value, onChange: typeof onChange, initialProductId });
  
  const { t } = useTranslation();

  // 状態管理
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedProductId, setSelectedProductId] = useState(initialProductId);
  const [selectedVariantId, setSelectedVariantId] = useState(value || "");

  // 商品データを取得
  useEffect(() => {
    console.log('🔄 ShopifyVariantSelector: useEffect triggered');
    const loadProducts = async () => {
      try {
        setLoading(true);
        setError("");
        console.log('🔄 ShopifyVariantSelector: Loading products...');
        const productsData = await fetchProductsWithVariants();
        console.log('📦 ShopifyVariantSelector: Products loaded:', productsData);
        setProducts(productsData);
      } catch (err) {
        console.error('❌ ShopifyVariantSelector: Failed to load products:', err);
        console.error('❌ ShopifyVariantSelector: Error details:', {
          name: err.name,
          message: err.message,
          stack: err.stack
        });
        setProducts([]);
        setError(t('shopifyVariantSelector.fetchError', { message: err.message }));
      } finally {
        setLoading(false);
      }
    };

    loadProducts();
  }, [t]);

  // デバッグログ
  console.log('🔍 ShopifyVariantSelector Debug:', {
    productsCount: products.length,
    error: error,
    loading: loading,
    selectedProductId: selectedProductId,
    selectedVariantId: selectedVariantId
  });

  // 選択された商品のバリアントオプションをメモ化
  const variantOptions = useMemo(() => {
    if (!selectedProductId || !products.length) {
      return [];
    }
    
    const product = products.find((p) => p.id === selectedProductId);
    if (!product || !product.variants) {
      return [];
    }
    
    return product.variants.map((v) => ({
        label: `${v.title}（SKU: ${v.sku || '-' }）` + 
          (v.selectedOptions && v.selectedOptions.length
            ? ` / ${v.selectedOptions.map(opt => `${opt.name}:${opt.value}`).join(', ')}`
            : ''),
        value: v.id,
        variant: v,
    }));
  }, [selectedProductId, products]);

  // value propの変更を監視して内部状態を同期
  useEffect(() => {
    if (value !== selectedVariantId) {
      setSelectedVariantId(value || "");
    }
  }, [value]);

  // 選択されたバリアントが変更された時の処理
  useEffect(() => {
    if (!selectedVariantId || !onChange) return;
    
    const product = products.find((p) => p.id === selectedProductId);
    const variant = variantOptions.find((v) => v.value === selectedVariantId)?.variant;
    
    if (product && variant) {
      console.log('✅ ShopifyVariantSelector: Variant selected:', { variantId: selectedVariantId, product: product.title });
      onChange(selectedVariantId, { product, variant });
    }
  }, [selectedVariantId, selectedProductId, products, variantOptions, onChange]);

  // 選択クリア処理
  const handleClearSelection = useCallback(() => {
    console.log('🗑️ ShopifyVariantSelector: Clearing selection');
    setSelectedProductId("");
    setSelectedVariantId("");
    if (onChange) {
      onChange("", {});
    }
  }, [onChange]);

  // 商品選択処理
  const handleProductChange = useCallback((value) => {
    console.log('📦 ShopifyVariantSelector: Product changed:', value);
    setSelectedProductId(value);
    // 商品が変更されたらバリアント選択をクリア
    setSelectedVariantId("");
    if (onChange) {
      onChange("", {});
    }
  }, [onChange]);

  // バリアント選択処理
  const handleVariantChange = useCallback((value) => {
    console.log('🔧 ShopifyVariantSelector: Variant changed:', value);
    setSelectedVariantId(value);
  }, []);

  // ローディング中
  if (loading) {
    console.log('⏳ ShopifyVariantSelector: Loading state');
    return (
      <div>
        <Text variant="headingSm">{t('shopifyVariantSelector.title')}</Text>
        <Spinner accessibilityLabel={t('shopifyVariantSelector.loadingProducts')} size="small" />
      </div>
    );
  }

  // エラー表示
  if (error) {
    console.log('❌ ShopifyVariantSelector: Error state:', error);
    return (
      <div>
        <Text variant="headingSm">{t('shopifyVariantSelector.title')}</Text>
        <Text tone="critical">{error}</Text>
      </div>
    );
  }

  console.log('✅ ShopifyVariantSelector: Ready state with', products.length, 'products');
  return (
    <div>
      <Text variant="headingSm">{t('shopifyVariantSelector.title')}</Text>
          <Select
            label={t('shopifyVariantSelector.productSelectLabel')}
            options={[
              { label: t('shopifyVariantSelector.pleaseSelect'), value: "" },
          ...products.map((p) => ({
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
      {selectedVariantId && (
        <Text variant="bodySm" tone="subdued">
          {t('shopifyVariantSelector.selectedVariantId', { variantId: selectedVariantId })}
        </Text>
      )}
    </div>
  );
};

export default ShopifyVariantSelector;