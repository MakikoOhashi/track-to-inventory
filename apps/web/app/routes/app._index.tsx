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

import CustomModal from '../components/Modal';
import StatusCard from '../components/StatusCard';
import StatusTable from '../components/StatusTable';
import OCRUploader from "../components/OCRUploader";
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';
import StartGuide from '~/components/StartGuide';

import type { Shipment,ShipmentItem } from '../../types/Shipment';


import { data as json, type LoaderFunctionArgs, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { i18n } from "~/utils/i18n.server";
import { makeLocaleCookie } from "~/utils/locale";

import { unauthenticated } from "~/shopify.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

type StatusTableProps = {
  shipments: Shipment[];
  onSelectShipment: (shipment: Shipment) => void;
};

type StatusStats = Record<string, Shipment[]>;

type PopupPos = { x: number; y: number };

async function loadShopifyProductsForShop(shop: string) {
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

  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(query, { variables: { first: 50 } });
  const jsonResponse = await response.json() as any;

  const products = (jsonResponse.data?.products?.edges || []).map(({ node }: any) => ({
    id: node.id,
    title: node.title,
    variants: (node.variants?.edges || []).map(({ node: v }: any) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      selectedOptions: v.selectedOptions || [],
    })),
  }));

  return products;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}


export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "";
    const locale = await i18n.getLocale(request);
    
    if (!shop) {
      throw new Response("Unauthorized", { status: 401 });
    }
    
    // Preview段階ではshop queryを信頼してSSR初期データだけ返す。
    let shipments = [];
    let shopifyProducts: any[] = [];
    try {
      const supabase = createSupabaseAdminClient();
      const { data, error } = await withTimeout(
        supabase
          .from('shipments')
          .select('*')
          .eq('shop_id', shop),
        5000,
        { data: null, error: null } as any,
      );
      
      if (error) {
        shipments = [];
      } else if (data) {
        shipments = data;
      }
    } catch (error) {
      shipments = [];
    }

    try {
      shopifyProducts = await withTimeout(loadShopifyProductsForShop(shop), 5000, []);
    } catch (error) {
      shopifyProducts = [];
    }
    
    return json({ shop, locale, shipments, shopifyProducts });
  } catch (error) {
    // 認証失敗時は401エラー
    if (error instanceof Response) {
      throw error;
    }
    throw new Response("Authentication failed", { status: 401 });
  }
};


export default function Index() {
  const { shop, shipments: initialShipments, locale: initialLocale, shopifyProducts: initialShopifyProducts } = useLoaderData<typeof loader>();
  const { t, i18n: i18nInstance } = useTranslation();
  const [hasMounted, setHasMounted] = useState(false);

  // 状態管理
  const [shipments, setShipments] = useState<Shipment[]>(initialShipments);
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
  const [shopId, setShopId] = useState<string>(shop || "");
  const [shopIdInput, setShopIdInput] = useState<string>(shop || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shopifyProducts, setShopifyProducts] = useState<any[]>(initialShopifyProducts || []);
  const [shopifyProductsLoading, setShopifyProductsLoading] = useState(false);
  const [shopifyProductsError, setShopifyProductsError] = useState("");
  const [showStartGuide, setShowStartGuide] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [detailViewMode, setDetailViewMode] = useState<'product' | 'status' | 'search'>('product');
  const [productStatsSort, setProductStatsSort] = useState<'name-asc' | 'name-desc'>('name-asc');
  const [siQuery, setSiQuery] = useState("");
  const [hoveredProduct, setHoveredProduct] = useState<string | null>(null);
  const [popupPos, setPopupPos] = useState<PopupPos>({ x: 0, y: 0 });
  const [locale, setLocale] = useState<string>(initialLocale || 'ja');
  const popupTimeout = useRef<NodeJS.Timeout | null>(null);

  // 定数
  const POPUP_WIDTH = 400;
  const POPUP_HEIGHT = 300;

  // 初期化時にデータを取得（shopIdが変更された時のみ）
  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!hasMounted || !shop) return;

    // SSRがタイムアウトや一時失敗で空になった場合の保険として、
    // クライアント側でも一度だけ明示的に再取得する。
    if (initialShipments.length === 0) {
      fetchShipments(shop);
    }
  }, [hasMounted, shop, initialShipments.length]);

  useEffect(() => {
    if (shopifyProducts.length > 0) {
      setShopifyProductsLoading(false);
      setShopifyProductsError("");
    }
  }, [shopifyProducts.length]);

  useEffect(() => {
    if (shopId && shopId !== shop) {
      fetchShipments(shopId);
    }
  }, [shopId, shop]);
  
  // ガイド関連
    const handleDismissGuide = () => {
      setShowStartGuide(false);
    localStorage.setItem('startGuideDismissed', 'true');
    };
  
    const handleShowGuide = () => setShowStartGuide(true);

  // 言語切り替えハンドラー
  const handleLanguageChange = (newLanguage: string) => {
    i18nInstance.changeLanguage(newLanguage);
    // 言語設定をlocalStorageに保存
    localStorage.setItem('i18nextLng', newLanguage);
    document.cookie = makeLocaleCookie(newLanguage);
    // 状態を更新して再レンダリングをトリガー
    setLocale(newLanguage);
  };

  // データ取得関数（認証済みshop_idのみ使用）
  const fetchShipments = async (shopIdValue: string) => {
    if (!shopIdValue || shopIdValue !== shop) {
      setError('認証エラーが発生しました');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
    const res = await fetch(`/api/shipments?shop_id=${encodeURIComponent(shopIdValue)}`);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      setShipments(data.shipments || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'データの取得に失敗しました');
      setShipments([]);
    } finally {
      setLoading(false);
    }
  };

  // --- 修正3: fetchData（全件取得関数）を削除し、handleModalCloseでshopIdで再取得 ---
  const handleModalClose = () => {
    setSelectedShipment(null);
    if (shopId) {
    fetchShipments(shopId); // ← 閉じたあともshopIdで絞り込んだデータを取得
    }
  };

  const handleInputChange = (value: string) => setShopIdInput(value);
  const handleShopIdApply = () => setShopId(shopIdInput);

  // SI番号で検索用（前方一致・上位10件）
  const filteredShipments = shipments
    .filter(
      (s) =>
        !siQuery ||
        (s.si_number && s.si_number.toLowerCase().startsWith(siQuery.toLowerCase()))
    )
    .slice(0, 10);
  // ステータスごとグループ化関数
  const getStatusStats = (shipments: Shipment[]): StatusStats => {
    const stats: StatusStats = {};
    
    shipments.forEach((s) => {
      // データベースの英語ステータスを翻訳された値に変換
      let translatedStatus: string;
      
      if (s.status === "siIssued") {
        translatedStatus = t('modal.status.siIssued');
      }
      else if (s.status === "scheduleConfirmed") {
        translatedStatus = t('modal.status.scheduleConfirmed');
      }
      else if (s.status === "shipping") {
        translatedStatus = t('modal.status.shipping');
      }
      else if (s.status === "customsClearance") {
        translatedStatus = t('modal.status.customsClearance');
      }
      else if (s.status === "warehouseArrival") {
        translatedStatus = t('modal.status.warehouseArrival');
      }
      else if (s.status === "productSync") {
        translatedStatus = t('status.productSync');
      }
      else if (s.status === "synced") {
        translatedStatus = t('modal.status.synced');
      }
      else {
        translatedStatus = t('status.notSet');
      }
      
      if (!stats[translatedStatus]) stats[translatedStatus] = [];
      stats[translatedStatus].push(s);
    });
    
    return stats;
  };

  const handleProductMouseEnter = (e: MouseEvent<HTMLElement>, name: string) => {
    if (popupTimeout.current) clearTimeout(popupTimeout.current);
    const rect = e.currentTarget.getBoundingClientRect();
    let x = rect.left;
    let y = rect.bottom + 8;

    // 右端はみ出し防止
    if (x + POPUP_WIDTH > window.innerWidth) {
      x = window.innerWidth - POPUP_WIDTH - 10;
    }
    // 下端はみ出し防止
    if (y + POPUP_HEIGHT > window.innerHeight) {
      y = Math.max(rect.top - POPUP_HEIGHT + 16, 10);
    }
    // 上端にもはみ出さないようにする
    if (y < 0) y = 10;

    setHoveredProduct(name);
    setPopupPos({ x, y });
  };

  
  const handleProductMouseLeave = () => {
        // すぐ消さず、200ms後に消す（ポップアップに入るチャンスを与える）
        popupTimeout.current = setTimeout(() => {
          setHoveredProduct(null);
        }, 200);
  };

  const handlePopupMouseEnter = () => {
    if (popupTimeout.current) clearTimeout(popupTimeout.current);
  };

  const handlePopupMouseLeave = () => {
      setHoveredProduct(null);
  };

  // 商品別統計の取得とソート
  const getProductStats = (
    shipments: Shipment[],
    sort: 'name-asc' | 'name-desc' = 'name-asc'
  ): [string, number][] => {
    const productMap = new Map<string, number>();
    
    shipments.forEach(shipment => {
      (shipment.items || []).forEach(item => {
        const name = item.name || 'Unknown';
        const quantity = Number(item.quantity) || 0;
        productMap.set(name, (productMap.get(name) || 0) + quantity);
      });
    });

    const result = Array.from(productMap.entries());
    
    // 自然順序ソート（数字を含む文字列を正しくソート）
    const naturalSort = (a: string, b: string, order: 'asc' | 'desc') => {
      const aParts = a.match(/(\d+|\D+)/g) || [];
      const bParts = b.match(/(\d+|\D+)/g) || [];
      
      const maxLength = Math.max(aParts.length, bParts.length);
      
      for (let i = 0; i < maxLength; i++) {
        const aPart = aParts[i] || '';
        const bPart = bParts[i] || '';
        
        const aIsNum = !isNaN(Number(aPart));
        const bIsNum = !isNaN(Number(bPart));
        
      if (aIsNum && bIsNum) {
          const diff = Number(aPart) - Number(bPart);
          if (diff !== 0) return order === 'asc' ? diff : -diff;
        } else {
          const diff = aPart.localeCompare(bPart);
          if (diff !== 0) return order === 'asc' ? diff : -diff;
        }
      }
      
      return 0;
    };

    return result.sort(([a], [b]) => naturalSort(a, b, sort === 'name-asc' ? 'asc' : 'desc'));
  };

  // OCR保存成功時の処理
  const handleOcrSaveSuccess = () => {
    if (shopId) {
      fetchShipments(shopId);
    }
  };

  const statusAliases: Record<string, string> = {
    "SI発行済": "siIssued",
    "SI Issued": "siIssued",
    "siIssued": "siIssued",
    "船積スケジュール確定": "scheduleConfirmed",
    "Shipping Schedule Confirmed": "scheduleConfirmed",
    "scheduleConfirmed": "scheduleConfirmed",
    "船積中": "shipping",
    "Shipping": "shipping",
    "shipping": "shipping",
    "輸入通関中": "customsClearance",
    "Import Customs Clearance": "customsClearance",
    "customsClearance": "customsClearance",
    "倉庫着": "warehouseArrival",
    "Warehouse Arrival": "warehouseArrival",
    "warehouseArrival": "warehouseArrival",
    "商品同期": "productSync",
    "Product Sync": "productSync",
    "productSync": "productSync",
    "同期済み": "synced",
    "Synced": "synced",
    "synced": "synced",
    "未設定": "notSet",
    "Not Set": "notSet",
    "notSet": "notSet",
  };

  const statusOrder = [
    "siIssued",
    "scheduleConfirmed",
    "shipping",
    "customsClearance",
    "warehouseArrival",
    "productSync",
    "synced",
  ];

  const getStatusKey = (status?: string | null) =>
    status ? statusAliases[status] || status : "notSet";

  const getStatusLabel = (status?: string | null) => {
    const statusKey = getStatusKey(status);
    if (statusKey === "productSync") return t('status.productSync');
    if (statusKey === "notSet") return t('status.notSet');
    return t(`modal.status.${statusKey}`);
  };

  // ETAの早い順でソートして上位2件を抽出
  const upcomingShipments = shipments
    .slice()
    .sort((a, b) => {
      const aEta = a.eta ? new Date(a.eta).getTime() : Infinity;
      const bEta = b.eta ? new Date(b.eta).getTime() : Infinity;
      return aEta - bEta;
    })    
    .slice(0, 2);
    
  // Polaris用タブ
  const tabs = [
    { id: 'search', content: t('tabs.search') },
    { id: 'product', content: t('tabs.product') },
    { id: 'status', content: t('tabs.status') },
  ];
  const selectedTab = tabs.findIndex(tab => tab.id === detailViewMode);

  const filteredAndSortedShipments = shipments
  .filter(s => (s.items || []).some(item => item.name === hoveredProduct))
  .sort((a, b) => {
    // まずstatus順
    const statusDiff =
      statusOrder.indexOf(getStatusKey(a.status)) -
      statusOrder.indexOf(getStatusKey(b.status));
    if (statusDiff !== 0) return statusDiff;
    // 同じstatusならETA順（undefinedならInfinityで一番後ろへ）
    const aEta = a.eta ? new Date(a.eta).getTime() : Infinity;
    const bEta = b.eta ? new Date(b.eta).getTime() : Infinity;
    return aEta - bEta;
  });

    const rows = filteredAndSortedShipments.map(s => {
      const item = (s.items || []).find(item => item.name === hoveredProduct);
      return [
        <span
          style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
          onClick={() => setSelectedShipment(s)}
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') setSelectedShipment(s); }}
          title={t('message.clickForDetails')}
          key={s.si_number}
          role="button"
        >
          {s.si_number}
        </span>,
        item?.name || 'Unknown',
        item?.quantity || 0,
        getStatusLabel(s.status)
      ];
    });

    

  // --- JSX ---
  if (!hasMounted) {
    return (
      <Page
        title={t('title.shipmentsByOwner')}
        primaryAction={<LanguageSwitcher value={locale || 'ja'} onChange={handleLanguageChange} />}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingLg">{t('title.upcomingArrivals')}</Text>
                  <Text as="p" variant="bodyMd">{t('message.loading') || 'Loading...'}</Text>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
  
      <Page
        title={t('title.shipmentsByOwner')}
       
        primaryAction={<LanguageSwitcher value={locale || 'ja'} onChange={handleLanguageChange} />}
      >
     
     <Layout>
        {/* メインコンテンツエリア */}
        <Layout.Section>
          <BlockStack gap="600">

        {/* <Card>
        <BlockStack>
          
          <TextField
            label={t('label.shopId')}
            value={shopIdInput}
            onChange={handleInputChange}
            autoComplete="off"
            placeholder={t('placeholder.shopId')}
            readOnly //
          />
        

          </BlockStack> 
        </Card> */}
       
        

        {/* StartGuide本体 */}
      {showStartGuide && (
        <StartGuide onDismiss={handleDismissGuide} />
      )}

     {/* ガイドが非表示ならヘルプボタンを右上に表示 */}
     {!showStartGuide && (
            <Box paddingBlockEnd="200">
              <InlineStack align="end">
                <Button
                  icon={QuestionCircleIcon}
                  onClick={handleShowGuide}
                  variant="plain"
                  size="large"
                  accessibilityLabel={t('button.showGuide')}
                >
                  {t('button.showGuide')}
                </Button>
              </InlineStack>
            </Box>
          )}

        <Card>
        
          <BlockStack gap="400"> 
          <Text as="h2" variant="headingLg" id="card-edit">{t('title.upcomingArrivals')}</Text>
          {/* <Text as="p" variant="bodyMd" tone="subdued">{t('message.upcomingArrivals')}</Text>
         */}
        {shipments.length === 0 ? (
            <Banner tone="info">{t('message.noData')}</Banner>
          ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {upcomingShipments.map((s) => (
            <li key={s.si_number} style={{ cursor: 'pointer', marginBottom: '0.5rem' }}>
            <span onClick={() => setSelectedShipment(s)}>
              {s.si_number} - <strong>ETA:</strong> {s.eta}
            </span>
            </li>
          ))}
        </ul>)
          }
          </BlockStack>
       
      {/* 表示切り替えボタン */}
      
       <BlockStack gap="500">
        
        <Text as="h2" variant="headingLg">{t('title.arrivalStatus')}</Text>
        {/* ▼▼▼ ここが変更点 ▼▼▼ */}
        <Tabs
          tabs={[
            { id: 'card', content: t('button.cardView') },
            { id: 'table', content: t('button.tableView') }
          ]}
          selected={viewMode === 'card' ? 0 : 1}
          onSelect={selectedIndex => {
            setViewMode(selectedIndex === 0 ? 'card' : 'table');
          }}
        />

      <Divider />
      {/* 表示形式に応じて切り替え */}
      
      {viewMode === 'card' ? (
        <InlineStack gap="400" wrap>
          {shipments.map((s) => (
             <StatusCard
             key={s.si_number}
             {...s}
             onSelectShipment={() => setSelectedShipment(s)} // 追加
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


      
      

{/* 詳細表示　　セクション */}
<Card>
  <BlockStack gap="500">

  <Text as="h2" variant="headingLg" id="detail-section">{t('title.detailDisplay')}</Text>

  {/* デバッグ情報 */}
  {process.env.NODE_ENV === 'development' && (
    <Banner tone="info">
      <p>デバッグ情報:</p>
      <p>Shipments数: {shipments.length}</p>
      <p>現在の言語: {locale}</p>
      <p>DetailViewMode: {detailViewMode}</p>
      <p>SelectedTab: {selectedTab}</p>
    </Banner>
  )}

                <Tabs 
                  tabs={tabs}
                  selected={selectedTab}
                  onSelect={(selectedIndex) => {
                    const selectedId = tabs[selectedIndex].id as 'product' | 'status' | 'search';
                    setDetailViewMode(selectedId);
                  }}
                />



  {/* ←この下にトグルで統計表を追加 */}
  <Divider />

      <BlockStack gap="500">
      <div style={{ maxWidth: "700px", margin: "0 auto", paddingTop: 32 }}>
       {/* 商品別 */}
       {detailViewMode === 'product' && (
      <BlockStack gap="400">
      <InlineStack align="space-between">
      <Text as="h3" variant="headingMd">{t('title.productArrivals')}</Text>
          
        <Button
          onClick={() =>

            setProductStatsSort(sort =>
              sort === 'name-asc' ? 'name-desc' : 'name-asc'
            )
          }
          size="slim"
          variant="plain"
        >
          {productStatsSort === 'name-asc' ?t('button.productNameAsc') : t('button.productNameDesc')}
        </Button>
      </InlineStack>

        <DataTable
            columnContentTypes={['text', 'numeric']}
            headings={[t('label.productName'), t('label.totalQuantity')]}
            rows={getProductStats(shipments, productStatsSort).map(([name, qty]) => [
              <span
              key={name}
              onMouseEnter={e => handleProductMouseEnter(e, name)}
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
     
      

     {/* ステータスごとのチャート */}
     {detailViewMode === 'status' && (
    <BlockStack gap="500">
    <Text as="h3" variant="headingMd">{t('title.statusChart')}</Text>
    
      {statusOrder.map((statusKey) => {
        const statusLabel = getStatusLabel(statusKey);
        const shipmentsForStatus = getStatusStats(shipments)[statusLabel] || [];
        
        const rows = shipmentsForStatus.flatMap((s) => {
          const items =
            s.items && s.items.length > 0
              ? s.items
              : [{ name: t('message.unknown'), quantity: '-' as const }];

          return items.map((item, index) => [
            <span
              style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
              onClick={() => setSelectedShipment(s)}
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') setSelectedShipment(s); }}
              title={t('message.clickForDetails')}
              key={`${s.si_number}-${item.name || 'unknown'}-${index}`}
            >
              {s.si_number}
            </span>,
            item.name || t('message.unknown'),
            item.quantity ?? '-',
            getStatusLabel(s.status)
          ]);
        });
        
        return rows.length > 0 ?(
          <Box key={statusKey} paddingBlock="400">
            <BlockStack gap="300">
            <Text as="h4" variant="headingMd">{statusLabel}</Text>
            <DataTable
              columnContentTypes={['text', 'text', 'numeric', 'text']}
              headings={[t('label.siNumber'), t('label.productName'), t('label.quantity'), t('label.status')]}
              rows={rows}
            />
          </BlockStack>
          </Box>
        ): (
          <Box key={statusKey} paddingBlock="400">
            <Text as="h4" variant="headingMd">{statusLabel}</Text>
            <Banner tone="info">{t('status.noData')}</Banner>
          </Box>
        );
        })}
      </BlockStack>
        )}



        {/* SI番号で検索 */}
        {detailViewMode === 'search' && (
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">{t('title.siSearch')}</Text>
              <Box maxWidth="400px">
              <TextField
                label={t('label.siNumber')}
                value={siQuery}
                onChange={setSiQuery}
                autoComplete="off"
                placeholder={t('placeholder.siNumber')}
                clearButton
                onClearButtonClick={() => setSiQuery('')}
              />
              </Box>

              {siQuery && (
                <>

              <DataTable
                columnContentTypes={['text', 'text', 'text']}
                headings={[t('label.siNumber'), t('label.eta'), t('label.supplier')]}
                rows={filteredShipments.map((s, idx) => [
                  <span
                    style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
                    onClick={() => setSelectedShipment(s)}
                    key={s.si_number}
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') setSelectedShipment(s); }}
                    title={t('message.clickForDetails')}
                  >
                    {s.si_number}
                  </span>,
                  s.eta,
                  s.supplier_name
                ])}
              />
              {filteredShipments.length === 0 && (
                <Banner tone="info">{t('message.noMatchingSi')}</Banner>
              )}
            </>
            )}
          </BlockStack>

          )}
          </div> 
          </BlockStack>  
                 
          </BlockStack>
          </Card>


       {/* ここにOCRアップローダーを追加 - shopIdを渡す */}
       {hasMounted && (
        <>
          <div id="ocr-section" />
          <OCRUploader 
            shopId={shop} 
            onSaveSuccess={handleOcrSaveSuccess}
          />
        </>
       )}
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
        {/* <Text as="p" variant="bodyMd" fontWeight="semibold">
          {t('message.siListWith', { productName: hoveredProduct })}
        </Text> */}
        <Box paddingBlockStart="200">
          <DataTable
            columnContentTypes={['text', 'text', 'numeric', 'text']}
            headings={[
              t('label.siNumber'),
              t('label.productName'),
              t('label.quantity'),
              t('label.status')
            ]}
            rows={rows}
          />
        </Box>
      </div>
    )}
  <Box paddingBlockEnd="1200" />

      {/* モーダル表示 */}
      {hasMounted && selectedShipment && (
        <CustomModal
          shipment={selectedShipment}
          onClose={handleModalClose}
          onUpdated={() => fetchShipments(shop)}
          shopifyProducts={shopifyProducts}
          shopifyProductsLoading={shopifyProductsLoading}
          shopifyProductsError={shopifyProductsError}
          locale={locale}
        />
      )}
    </Page>
  );
}
