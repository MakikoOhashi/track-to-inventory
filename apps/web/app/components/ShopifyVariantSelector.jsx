import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Select, Spinner, Button, Text } from '@shopify/polaris';
import { useTranslation } from 'react-i18next';
import { fetchProductsWithVariants, getShopifyProductsCache } from "~/lib/shopifyProducts.client";

const ShopifyVariantSelector = ({ value, onChange, initialProductId = "", products: productsProp = null, loading: loadingProp = false, error: errorProp = "" }) => {
  
  const { t } = useTranslation();

  // 状態管理
  const [products, setProducts] = useState(productsProp || []);
  const [loading, setLoading] = useState(Boolean(loadingProp));
  const [error, setError] = useState(errorProp || "");
  const [selectedProductId, setSelectedProductId] = useState(initialProductId);
  const [selectedVariantId, setSelectedVariantId] = useState(value || "");
  const debugState = error ? "error" : loading ? "loading" : products.length > 0 ? "ready" : "idle";

  // 商品データを取得
  useEffect(() => {
    const hasProvidedProducts = Array.isArray(productsProp) && productsProp.length > 0;
    const shouldUseProvidedState = hasProvidedProducts || loadingProp || Boolean(errorProp);

    if (shouldUseProvidedState) {
      setProducts(productsProp || []);
      setLoading(Boolean(loadingProp));
      setError(errorProp || "");
      return;
    }

    let isActive = true;
    const loadProducts = async () => {
      try {
        const cached = getShopifyProductsCache();
        if (cached) {
          if (isActive) {
            setProducts(cached);
            setError("");
            setLoading(false);
          }
          return;
        }

        setLoading(true);
        setError("");
        const productsData = await fetchProductsWithVariants();
        if (isActive) {
          setProducts(productsData);
        }
      } catch (err) {
        if (isActive) {
          setProducts([]);
          setError(t('shopifyVariantSelector.fetchError', { message: err.message }));
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    loadProducts();
    return () => {
      isActive = false;
    };
  }, [t, productsProp, loadingProp, errorProp]);

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
      onChange(selectedVariantId, { product, variant });
    }
  }, [selectedVariantId, selectedProductId, products, variantOptions, onChange]);

  // 選択クリア処理
  const handleClearSelection = useCallback(() => {
    setSelectedProductId("");
    setSelectedVariantId("");
    if (onChange) {
      onChange("", {});
    }
  }, [onChange]);

  // 商品選択処理
  const handleProductChange = useCallback((value) => {
    setSelectedProductId(value);
    // 商品が変更されたらバリアント選択をクリア
    setSelectedVariantId("");
    if (onChange) {
      onChange("", {});
    }
  }, [onChange]);

  // バリアント選択処理
  const handleVariantChange = useCallback((value) => {
    setSelectedVariantId(value);
  }, []);

  // ローディング中
  if (loading) {
    return (
      <div>
        <Text variant="headingSm">{t('shopifyVariantSelector.title')}</Text>
        <Spinner accessibilityLabel={t('shopifyVariantSelector.loadingProducts')} size="small" />
      </div>
    );
  }

  // エラー表示
  if (error) {
    return (
      <div>
        <Text variant="headingSm">{t('shopifyVariantSelector.title')}</Text>
        <Text tone="critical">{error}</Text>
      </div>
    );
  }
  return (
    <div>
      <Text variant="headingSm">{t('shopifyVariantSelector.title')}</Text>
      <Text variant="bodySm" tone="subdued">
        {`debug: ${debugState}`}
      </Text>
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
