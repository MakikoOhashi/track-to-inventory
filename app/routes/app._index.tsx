//app/routes/app._index.tsx

import React, { useEffect, useState, useRef, MouseEvent } from 'react';
import {
  Page,
  Card,
  BlockStack,
  Button,
  ButtonGroup,
  DataTable,
  TextField,
  Banner,
  InlineStack,
  Text,
  Tabs,
  Divider,
  Box,
  Layout,
} from '@shopify/polaris';
import { QuestionCircleIcon } from '@shopify/polaris-icons';
import { ErrorBoundary } from 'react-error-boundary';

import CustomModal from '../components/Modal';
import StatusCard from '../components/StatusCard';
import StatusTable from '../components/StatusTable';
import OCRUploader from "../components/OCRUploader";
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';
import StartGuide from '../components/StartGuide';

import type { Shipment, ShipmentItem } from '../../types/Shipment';

import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useTranslation } from "react-i18next";
import { i18n } from "~/utils/i18n.server";
import { authenticate } from "~/shopify.server";

// 型定義
type StatusStats = Record<string, Shipment[]>;
type PopupPos = { x: number; y: number };
type ViewMode = 'card' | 'table';
type DetailViewMode = 'product' | 'status' | 'search';
type ProductStatsSort = 'name-asc' | 'name-desc';

// Loader型定義
type LoaderData = {
  shop: string;
  locale: string;
  shipments: Shipment[];
  hasSeenGuide: boolean;
};

// Error Fallback Component
function AppErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
  return (
    <Page>
      <Card>
        <BlockStack gap="400">
          <Text variant="headingLg" as="h2">エラーが発生しました</Text>
          <Text as="p">申し訳ございませんが、アプリケーションでエラーが発生しました。</Text>
          <Button onClick={resetErrorBoundary} variant="primary">
            再試行
          </Button>
          {process.env.NODE_ENV === 'development' && (
            <details>
              <summary>エラー詳細</summary>
              <pre style={{ 
                backgroundColor: '#f5f5f5', 
                padding: '10px', 
                overflow: 'auto',
                fontSize: '12px'
              }}>
                {error.message}
                {error.stack}
              </pre>
            </details>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}

// サーバーサイドからの初期設定取得のためのヘルパー
async function getInitialSettings(request: Request) {
  // Cookieから設定を取得（実装例）
  const cookie = request.headers.get('Cookie');
  const hasSeenGuide = cookie?.includes('hasSeenGuide=true') || false;
  
  return { hasSeenGuide };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Shopifyセッションからshopドメインを取得
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const locale = await i18n.getLocale(request);
    
    // 初期設定取得
    const { hasSeenGuide } = await getInitialSettings(request);
    
    // shipmentsデータを取得
    let shipments: Shipment[] = [];
    if (shop) {
      const url = new URL(request.url);
      const shopId = url.searchParams.get('shop_id') || shop;
      
      // 内部API呼び出しまたは直接DB呼び出し
      const shipmentsUrl = `${url.origin}/api/shipments?shop_id=${encodeURIComponent(shopId)}`;
      const response = await fetch(shipmentsUrl);
      
      if (response.ok) {
        const data = await response.json();
        shipments = Array.isArray(data.data) ? data.data : [];
      }
    }
    
    return json<LoaderData>({ 
      shop, 
      locale, 
      shipments,
      hasSeenGuide 
    });
  } catch (error) {
    console.error('Loader error:', error);
    throw new Response('Failed to load data', { status: 500 });
  }
};

// Action for server-side mutations
export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const actionType = formData.get('actionType');
  
  switch (actionType) {
    case 'dismissGuide':
      // Set cookie for hasSeenGuide
      return json(
        { success: true },
        {
          headers: {
            'Set-Cookie': 'hasSeenGuide=true; Path=/; Max-Age=31536000', // 1 year
          },
        }
      );
    
    case 'refreshShipments':
      // リダイレクトしてloaderを再実行
      return json({ success: true });
    
    default:
      return json({ error: 'Invalid action' }, { status: 400 });
  }
};

export default function Index() {
  const { shop, locale, shipments, hasSeenGuide } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  
  // 翻訳
  const { t, i18n } = useTranslation();
  
  // 状態管理（サーバーから初期化）
  const [lang, setLang] = useState(locale || 'ja');
  const [isI18nReady, setIsI18nReady] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
  const [hoveredProduct, setHoveredProduct] = useState<string | null>(null);
  const [popupPos, setPopupPos] = useState<PopupPos>({ x: 0, y: 0 });
  const [productStatsSort, setProductStatsSort] = useState<ProductStatsSort>('name-asc');
  const [detailViewMode, setDetailViewMode] = useState<DetailViewMode>('product');
  const [siQuery, setSiQuery] = useState<string>('');
  const [showStartGuide, setShowStartGuide] = useState(!hasSeenGuide);

  // 安全な翻訳関数
  const safeTranslate = (key: string, fallback: string) => {
    try {
      const result = t(key);
      return result && result !== key ? result : fallback;
    } catch (error) {
      console.warn(`Translation error for key: ${key}`, error);
      return fallback;
    }
  };

  // i18n初期化
  useEffect(() => {
    const initI18n = async () => {
      try {
        await i18n.changeLanguage(lang);
        setIsI18nReady(true);
      } catch (error) {
        console.error('Language change error:', error);
        setIsI18nReady(true);
      }
    };
    
    initI18n();
  }, [lang, i18n]);

  // イベントハンドラー
  const handleDismissGuide = () => {
    setShowStartGuide(false);
    // サーバーサイドでCookie設定
    fetcher.submit(
      { actionType: 'dismissGuide' },
      { method: 'POST' }
    );
  };

  const handleShowGuide = () => setShowStartGuide(true);

  const handleModalClose = () => {
    setSelectedShipment(null);
    // データを再取得
    revalidator.revalidate();
  };

  const handleOcrSaveSuccess = () => {
    // データを再取得
    revalidator.revalidate();
  };

  // データ処理関数
  const getUpcomingShipments = (shipments: Shipment[], limit: number = 2) => {
    return shipments
      .slice()
      .sort((a, b) => {
        const aEta = a.eta ? new Date(a.eta).getTime() : Infinity;
        const bEta = b.eta ? new Date(b.eta).getTime() : Infinity;
        return aEta - bEta;
      })
      .slice(0, limit);
  };

  const getFilteredShipments = (shipments: Shipment[], query: string, limit: number = 10) => {
    return shipments.filter(
      (s) =>
        !query ||
        (s.si_number && s.si_number.toLowerCase().startsWith(query.toLowerCase()))
    ).slice(0, limit);
  };

  const getStatusStats = (shipments: Shipment[]): StatusStats => {
    const stats: StatusStats = {};
    shipments.forEach((s) => {
      const status = s.status || safeTranslate('status.notSet', 'Not Set');
      if (!stats[status]) stats[status] = [];
      stats[status].push(s);
    });
    return stats;
  };

  const getProductStats = (
    shipments: Shipment[],
    sort: ProductStatsSort = 'name-asc'
  ): [string, number][] => {
    const stats: Record<string, number> = {};
    shipments.forEach((s) => {
      (s.items || []).forEach((item) => {
        if (!item.name) return;
        stats[item.name] = (stats[item.name] || 0) + Number(item.quantity || 0);
      });
    });
    
    const sorted = Object.entries(stats).sort((a, b) => {
      if (sort === 'name-asc') {
        return a[0].localeCompare(b[0], "ja");
      } else {
        return b[0].localeCompare(a[0], "ja");
      }
    });
    
    return sorted;
  };

  // ポップアップ関連
  const popupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const POPUP_WIDTH = 320;
  const POPUP_HEIGHT = 180;

  const handleProductMouseEnter = (e: MouseEvent<HTMLElement>, name: string) => {
    if (popupTimeout.current) clearTimeout(popupTimeout.current);
    const rect = e.currentTarget.getBoundingClientRect();
    let x = rect.left;
    let y = rect.bottom + 4;

    if (x + POPUP_WIDTH > window.innerWidth) {
      x = window.innerWidth - POPUP_WIDTH - 10;
    }
    if (y + POPUP_HEIGHT > window.innerHeight) {
      y = rect.top - POPUP_HEIGHT - 4;
    }
    if (y < 0) y = 10;

    setHoveredProduct(name);
    setPopupPos({ x, y });
  };

  const handleProductMouseLeave = () => {
    popupTimeout.current = setTimeout(() => {
      setHoveredProduct(null);
    }, 200);
  };

  const handlePopupMouseEnter = () => {
    if (popupTimeout.current) clearTimeout(popupTimeout.current);
  };

  const handlePopupMouseLeave = () => {
    popupTimeout.current = setTimeout(() => {
      setHoveredProduct(null);
    }, 200);
  };

  // 計算されたデータ
  const upcomingShipments = getUpcomingShipments(shipments);
  const filteredShipments = getFilteredShipments(shipments, siQuery);
  const statusStats = getStatusStats(shipments);
  const productStats = getProductStats(shipments, productStatsSort);

  // 翻訳データ
  const statusOrder = [
    safeTranslate('modal.status.siIssued', 'SI Issued'),
    safeTranslate('modal.status.scheduleConfirmed', 'Schedule Confirmed'),
    safeTranslate('modal.status.shipping', 'Shipping'),
    safeTranslate('modal.status.customsClearance', 'Customs Clearance'),
    safeTranslate('modal.status.warehouseArrival', 'Warehouse Arrival'),
    safeTranslate('status.productSync', 'Product Sync'),
    safeTranslate('modal.status.synced', 'Synced')
  ];

  const tabs = [
    { id: 'search', content: safeTranslate('tabs.search', 'Search') },
    { id: 'product', content: safeTranslate('tabs.product', 'Product') },
    { id: 'status', content: safeTranslate('tabs.status', 'Status') },
  ];

  const selectedTab = Math.max(0, tabs.findIndex(tab => tab.id === detailViewMode));

  // ポップアップ用データ
  const filteredAndSortedShipments = shipments
    .filter((s) => (s.items || []).some(item => item.name === hoveredProduct))
    .sort((a, b) => {
      const aStatus = a.status ?? safeTranslate('status.notSet', 'Not Set');
      const bStatus = b.status ?? safeTranslate('status.notSet', 'Not Set');
      const statusDiff = statusOrder.indexOf(aStatus) - statusOrder.indexOf(bStatus);
      if (statusDiff !== 0) return statusDiff;
      const aEta = a.eta ? new Date(a.eta).getTime() : Infinity;
      const bEta = b.eta ? new Date(b.eta).getTime() : Infinity;
      return aEta - bEta;
    });

  const popupRows = filteredAndSortedShipments.map((s) => {
    const item = (s.items || []).find(item => item.name === hoveredProduct);
    return [
      <span
        style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
        onClick={() => setSelectedShipment(s)}
        tabIndex={0}
        onKeyDown={(e: any) => { if (e.key === 'Enter') setSelectedShipment(s); }}
        title={safeTranslate('message.clickForDetails', 'Click for details')}
        key={s.si_number}
        role="button"
      >
        {s.si_number}
      </span>,
      item?.name ?? '',
      item?.quantity ?? '',
      s.status || 'Not Set'
    ];
  });

  // ローディング表示
  if (!isI18nReady) {
    return (
      <Page>
        <Card>
          <BlockStack gap="400">
            <Text variant="headingLg" as="h2">読み込み中...</Text>
            <Text as="p">翻訳データを読み込んでいます。</Text>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  // レンダリング
  return (
    <ErrorBoundary FallbackComponent={AppErrorFallback}>
      <Page
        title={safeTranslate('title.shipmentsByOwner', 'Shipments by Owner')}
        primaryAction={<LanguageSwitcher value={lang} onChange={setLang} />}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="600">
              {/* StartGuide */}
              {showStartGuide && (
                <StartGuide onDismiss={handleDismissGuide} />
              )}

              {/* ヘルプボタン */}
              {!showStartGuide && (
                <Box paddingBlockEnd="200">
                  <InlineStack align="end">
                    <Button
                      icon={QuestionCircleIcon}
                      onClick={handleShowGuide}
                      variant="plain"
                      size="large"
                      accessibilityLabel={safeTranslate('button.showGuide', 'Show Guide')}
                    >
                      {safeTranslate('button.showGuide', 'Show Guide')}
                    </Button>
                  </InlineStack>
                </Box>
              )}

              {/* Upcoming Arrivals */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingLg">
                    {safeTranslate('title.upcomingArrivals', 'Upcoming Arrivals')}
                  </Text>
                  {shipments.length === 0 ? (
                    <Banner tone="info">
                      {safeTranslate('message.noData', 'No data available')}
                    </Banner>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {upcomingShipments.map((s) => (
                        <li key={s.si_number} style={{ cursor: 'pointer', marginBottom: '0.5rem' }}>
                          <span onClick={() => setSelectedShipment(s)}>
                            {s.si_number} - <strong>ETA:</strong> {s.eta || 'Not set'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </BlockStack>
              </Card>

              {/* Arrival Status */}
              <Card>
                <BlockStack gap="500">
                  <Text as="h2" variant="headingLg">
                    {safeTranslate('title.arrivalStatus', 'Arrival Status')}
                  </Text>
                  
                  <Tabs
                    tabs={[
                      { id: 'card', content: safeTranslate('button.cardView', 'Card View') },
                      { id: 'table', content: safeTranslate('button.tableView', 'Table View') }
                    ]}
                    selected={viewMode === 'card' ? 0 : 1}
                    onSelect={(selectedIndex) => {
                      setViewMode(selectedIndex === 0 ? 'card' : 'table');
                    }}
                  />

                  <Divider />

                  {viewMode === 'card' ? (
                    <InlineStack gap="400" wrap>
                      {shipments.map((s) => (
                        <StatusCard
                          key={s.si_number}
                          {...s}
                          onSelectShipment={() => setSelectedShipment(s)}
                        />
                      ))}
                    </InlineStack>
                  ) : (
                    <StatusTable 
                      shipments={shipments} 
                      onSelectShipment={(shipment) => setSelectedShipment(shipment)}
                    />
                  )}
                </BlockStack>
              </Card>

              {/* Detail Display */}
              <Card>
                <BlockStack gap="500">
                  <Text as="h2" variant="headingLg">
                    {safeTranslate('title.detailDisplay', 'Detail Display')}
                  </Text>

                  <Tabs 
                    tabs={tabs}
                    selected={selectedTab}
                    onSelect={(selectedIndex) => {
                      const selectedId = tabs[selectedIndex].id as DetailViewMode;
                      setDetailViewMode(selectedId);
                    }}
                  />

                  <Divider />

                  <BlockStack gap="500">
                    <div style={{ maxWidth: "700px", margin: "0 auto", paddingTop: 32 }}>
                      
                      {/* Product View */}
                      {detailViewMode === 'product' && (
                        <BlockStack gap="400">
                          <InlineStack align="space-between">
                            <Text as="h3" variant="headingMd">
                              {safeTranslate('title.productArrivals', 'Product Arrivals')}
                            </Text>
                            <Button
                              onClick={() => setProductStatsSort(sort =>
                                sort === 'name-asc' ? 'name-desc' : 'name-asc'
                              )}
                              size="slim"
                              variant="plain"
                            >
                              {productStatsSort === 'name-asc' 
                                ? safeTranslate('button.productNameAsc', 'Product Name (A-Z)') 
                                : safeTranslate('button.productNameDesc', 'Product Name (Z-A)')}
                            </Button>
                          </InlineStack>

                          <DataTable
                            columnContentTypes={['text', 'numeric']}
                            headings={[
                              safeTranslate('label.productName', 'Product Name'), 
                              safeTranslate('label.totalQuantity', 'Total Quantity')
                            ]}
                            rows={productStats.map(([name, qty]) => [
                              <span
                                key={name}
                                onMouseEnter={(e) => handleProductMouseEnter(e, name)}
                                onMouseLeave={handleProductMouseLeave}
                                style={{ cursor: "pointer", textDecoration: "underline" }}
                              >
                                {name}
                              </span>,
                              qty
                            ])}
                          />
                        </BlockStack>
                      )}

                      {/* Status View */}
                      {detailViewMode === 'status' && (
                        <BlockStack gap="500">
                          <Text as="h3" variant="headingMd">
                            {safeTranslate('title.statusChart', 'Status Chart')}
                          </Text>
                          {statusOrder.map(status => {
                            const shipmentsForStatus = statusStats[status] || [];
                            const rows = shipmentsForStatus.flatMap((s) =>
                              (s.items || []).map(item => [
                                <span
                                  style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
                                  onClick={() => setSelectedShipment(s)}
                                  tabIndex={0}
                                  onKeyDown={(e: any) => { if (e.key === 'Enter') setSelectedShipment(s); }}
                                  title={safeTranslate('message.clickForDetails', 'Click for details')}
                                  key={s.si_number + item.name}
                                >
                                  {s.si_number}
                                </span>, 
                                item.name,
                                item.quantity
                              ])
                            );
                            return rows.length > 0 ? (
                              <Box key={status} paddingBlock="400">
                                <BlockStack gap="300">
                                  <Text as="h4" variant="headingMd">{status}</Text>
                                  <DataTable
                                    columnContentTypes={['text', 'text', 'numeric']}
                                    headings={[
                                      safeTranslate('label.siNumber', 'SI Number'), 
                                      safeTranslate('label.productName', 'Product Name'), 
                                      safeTranslate('label.quantity', 'Quantity')
                                    ]}
                                    rows={rows}
                                  />
                                </BlockStack>
                              </Box>
                            ) : null;
                          })}
                        </BlockStack>
                      )}

                      {/* Search View */}
                      {detailViewMode === 'search' && (
                        <BlockStack gap="400">
                          <Text as="h3" variant="headingMd">
                            {safeTranslate('title.siSearch', 'SI Search')}
                          </Text>
                          <Box maxWidth="400px">
                            <TextField
                              label={safeTranslate('label.siNumber', 'SI Number')}
                              value={siQuery}
                              onChange={setSiQuery}
                              autoComplete="off"
                              placeholder={safeTranslate('placeholder.siNumber', 'Enter SI number')}
                              clearButton
                              onClearButtonClick={() => setSiQuery('')}
                            />
                          </Box>

                          {siQuery && (
                            <>
                              <DataTable
                                columnContentTypes={['text', 'text', 'text']}
                                headings={[
                                  safeTranslate('label.siNumber', 'SI Number'), 
                                  safeTranslate('label.eta', 'ETA'), 
                                  safeTranslate('label.supplier', 'Supplier')
                                ]}
                                rows={filteredShipments.map((s) => [
                                  <span
                                    style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
                                    onClick={() => setSelectedShipment(s)}
                                    key={s.si_number}
                                    tabIndex={0}
                                    onKeyDown={(e: any) => { if (e.key === 'Enter') setSelectedShipment(s); }}
                                    title={safeTranslate('message.clickForDetails', 'Click for details')}
                                  >
                                    {s.si_number}
                                  </span>,
                                  s.eta,
                                  s.supplier_name
                                ])}
                              />
                              {filteredShipments.length === 0 && (
                                <Banner tone="info">
                                  {safeTranslate('message.noMatchingSi', 'No matching SI numbers found')}
                                </Banner>
                              )}
                            </>
                          )}
                        </BlockStack>
                      )}
                    </div>
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* OCR Uploader */}
              <OCRUploader 
                shopId={shop} 
                onSaveSuccess={handleOcrSaveSuccess}
              />
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* ポップアップ */}
        {hoveredProduct && (
          <div
            style={{
              position: "fixed",
              top: popupPos.y,
              left: popupPos.x,
              background: "#fff",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              boxShadow: "0 4px 8px rgba(0, 0, 0, 0.1)",
              padding: "16px",
              zIndex: 99999,
              minWidth: `${POPUP_WIDTH}px`,
              maxWidth: `${POPUP_WIDTH}px`,
              maxHeight: `${POPUP_HEIGHT}px`,
              overflowY: "auto",
              fontSize: "14px"
            }}
            onMouseEnter={handlePopupMouseEnter}
            onMouseLeave={handlePopupMouseLeave}
          >
            <Box paddingBlockStart="200">
              <DataTable
                columnContentTypes={['text', 'text', 'numeric', 'text']}
                headings={[
                  safeTranslate('label.siNumber', 'SI Number'),
                  safeTranslate('label.productName', 'Product Name'),
                  safeTranslate('label.quantity', 'Quantity'),
                  safeTranslate('label.status', 'Status')
                ]}
                rows={popupRows}
              />
            </Box>
          </div>
        )}

        <Box paddingBlockEnd="1200" />

        {/* モーダル */}
        {selectedShipment && (
          <CustomModal
            shipment={selectedShipment}
            onClose={handleModalClose}
            onUpdated={handleOcrSaveSuccess}
          />
        )}
      </Page>
    </ErrorBoundary>
  );
}