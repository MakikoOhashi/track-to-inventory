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

import type { Shipment,ShipmentItem } from '../../types/Shipment';


import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useTranslation } from "react-i18next";
import { i18n } from "~/utils/i18n.server";

// --- ① LoaderでShopifyセッションからshop（Shop ID）を取得 ---
import { authenticate } from "~/shopify.server"; // ←例: Shopify Remix SDK

// Error Fallback Component for the main app
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

type StatusTableProps = {
  shipments: Shipment[];
  onSelectShipment: (shipment: Shipment) => void;
};

type StatusStats = Record<string, Shipment[]>;

type PopupPos = { x: number; y: number };


export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Shopifyセッションからshopドメインを取得
  const { session } = await authenticate.admin(request);
  const shop = session.shop; // ここで取得できるかチェック
  const locale = await i18n.getLocale(request);
  return json({ shop, locale });
};


export default function Index() {
  // --- ② useLoaderDataでshopを受け取る ---
  const { shop, locale } = useLoaderData<typeof loader>();
  
  console.log("Index component - shop:", shop, "locale:", locale);
  
  // 安全な初期化
  let translationHook;
  try {
    translationHook = useTranslation();
  } catch (error) {
    console.error('Translation hook error:', error);
    // フォールバック
    translationHook = {
      t: (key: string) => {
        console.warn(`Translation key not found: ${key}`);
        return key;
      },
      i18n: { changeLanguage: () => {} }
    };
  }
  
  const { t, i18n } = translationHook;
  const [lang, setLang] = useState(locale || 'ja');
  const [isI18nReady, setIsI18nReady] = useState(false);

  // --- ③ shopId関連のstateを初期化・同期 ---
  const [shopIdInput, setShopIdInput] = useState<string>(shop || ''); // ←初期値にshopを使う
  const [shopId, setShopId] = useState<string>(shop || '');

  useEffect(() => {
    try {
      console.log("Changing language to:", lang);
      i18n.changeLanguage(lang);
      setIsI18nReady(true);
    } catch (error) {
      console.error('Language change error:', error);
      setIsI18nReady(true); // エラーでもレンダリングを続行
    }
  }, [lang, i18n]);

  // i18nが準備できていない場合はローディング表示
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

  //const [shopIdInput, setShopIdInput] = useState<string>("test-owner");
  //const [shopId, setShopId] = useState<string>("test-owner");
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [hoveredProduct, setHoveredProduct] = useState<string | null>(null);
  const [popupPos, setPopupPos] = useState<PopupPos>({ x: 0, y: 0 });
  const [productStatsSort, setProductStatsSort] = useState<'name-asc' | 'name-desc'>('name-asc');
  const [detailViewMode, setDetailViewMode] = useState<'product' | 'status' | 'search'>('product');
  const [siQuery, setSiQuery] = useState<string>('');

    // StartGuideの表示状態を親で管理
    const [showStartGuide, setShowStartGuide] = useState(false);

    useEffect(() => {
      // 初回表示ロジック
      const hasSeenGuide = localStorage.getItem('hasSeenStartGuide') ;
     
      if (hasSeenGuide  !== 'true') {
        setShowStartGuide(true);
      }
    }, []);
  
    // StartGuideを閉じた時のコールバック
    const handleDismissGuide = () => {
      setShowStartGuide(false);
      localStorage.setItem('hasSeenStartGuide', 'true');
      // Supabaseの更新もここで
    };
  
    // 「？」ボタン押下でStartGuide再表示
    const handleShowGuide = () => setShowStartGuide(true);

  const popupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const POPUP_WIDTH = 320;
  const POPUP_HEIGHT = 180;

  // ステータス日本語→英語キー変換マップ
  const statusJaToKey = {
    "SI発行済": "siIssued",
    "船積スケジュール確定": "scheduleConfirmed",
    "船積中": "shipping",
    "輸入通関中": "customsClearance",
    "倉庫着": "warehouseArrival",
    "同期済み": "synced"
  };

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

  // statusTranslationMapの定義も関数内で
  const statusTranslationMap: Record<string, string> = {
    "SI発行済": safeTranslate('modal.status.siIssued', 'SI Issued'),
    "船積スケジュール確定": safeTranslate('modal.status.scheduleConfirmed', 'Schedule Confirmed'),
    "船積中": safeTranslate('modal.status.shipping', 'Shipping'),
    "輸入通関中": safeTranslate('modal.status.customsClearance', 'Customs Clearance'),
    "倉庫着": safeTranslate('modal.status.warehouseArrival', 'Warehouse Arrival'),
    "同期済み": safeTranslate('modal.status.synced', 'Synced'),
    "siIssued": safeTranslate('modal.status.siIssued', 'SI Issued'),
    "scheduleConfirmed": safeTranslate('modal.status.scheduleConfirmed', 'Schedule Confirmed'),
    "shipping": safeTranslate('modal.status.shipping', 'Shipping'),
    "customsClearance": safeTranslate('modal.status.customsClearance', 'Customs Clearance'),
    "warehouseArrival": safeTranslate('modal.status.warehouseArrival', 'Warehouse Arrival'),
    "synced": safeTranslate('modal.status.synced', 'Synced'),
    "未設定": safeTranslate('status.notSet', 'Not Set'),
  };

  const statusOrder = [
    safeTranslate('modal.status.siIssued', 'SI Issued'),
    safeTranslate('modal.status.scheduleConfirmed', 'Schedule Confirmed'),
    safeTranslate('modal.status.shipping', 'Shipping'),
    safeTranslate('modal.status.customsClearance', 'Customs Clearance'),
    safeTranslate('modal.status.warehouseArrival', 'Warehouse Arrival'),
    safeTranslate('status.productSync', 'Product Sync'),
    safeTranslate('modal.status.synced', 'Synced')
  ];

  // 修正1: supabaseで直接取得→API経由に変更
  const fetchShipments = async (shopIdValue: string) => {
    try {
      console.log("Fetching shipments for shopId:", shopIdValue);
      const res = await fetch(`/api/shipments?shop_id=${encodeURIComponent(shopIdValue)}`);
      if (!res.ok) {
        console.error("Shipments API error:", res.status, res.statusText);
        setShipments([]);
        return;
      }
      const json = await res.json();
      console.log("Shipments API response:", json);
      setShipments(Array.isArray(json.data) ? json.data : []);
    } catch (error) {
      console.error("Fetch shipments error:", error);
      setShipments([]);
    }
  };

  // --- 修正2: useEffectでshopIdが変わった時だけfetchShipments実行 ---
  useEffect(() => {
    if (shopId) {
      fetchShipments(shopId);
    }
  }, [shopId]);

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
      const status = s.status || t('status.notSet') || 'Not Set';
      if (!stats[status]) stats[status] = [];
      stats[status].push(s);
    });
    return stats;
  };

  const handleProductMouseEnter = (e: MouseEvent<HTMLElement>, name: string) => {
    if (popupTimeout.current) clearTimeout(popupTimeout.current);
    const rect = e.currentTarget.getBoundingClientRect();
    let x = rect.left;
    let y = rect.bottom + 4;


    // 右端はみ出し防止
    if (x + POPUP_WIDTH > window.innerWidth) {
      x = window.innerWidth - POPUP_WIDTH - 10;
    }
    // 下端はみ出し防止
    if (y + POPUP_HEIGHT > window.innerHeight) {
      y = rect.top - POPUP_HEIGHT - 4;
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
    popupTimeout.current = setTimeout(() => {
      setHoveredProduct(null);
    }, 200);
  };

  const getProductStats = (
    shipments: Shipment[],
    sort: 'name-asc' | 'name-desc' = 'name-asc'
  ): [string, number][] => {
    const stats: Record<string, number> = {};
    shipments.forEach((s) => {
      (s.items || []).forEach((item) => {
        if (!item.name) return;
        stats[item.name] = (stats[item.name] || 0) + Number(item.quantity || 0);
      });
    });
    const naturalSort = (a: string, b: string, order: 'asc' | 'desc') => {
      const aIsNum = /^\d/.test(a);
      const bIsNum = /^\d/.test(b);
      if (aIsNum && !bIsNum) return order === 'asc' ? -1 : 1;
      if (!aIsNum && bIsNum) return order === 'asc' ? 1 : -1;
      if (aIsNum && bIsNum) {
        const aNum = parseInt(a.match(/^\d+/)?.[0] ?? '0', 10);
        const bNum = parseInt(b.match(/^\d+/)?.[0] ?? '0', 10);
        if (aNum !== bNum) return order === 'asc' ? aNum - bNum : bNum - aNum;
        return order === 'asc' ? a.localeCompare(b, "ja") : b.localeCompare(a, "ja");
      }
      const aIsAlpha = /^[a-zA-Z]/.test(a);
      const bIsAlpha = /^[a-zA-Z]/.test(b);
      if (aIsAlpha && !bIsAlpha) return order === 'asc' ? -1 : 1;
      if (!aIsAlpha && bIsAlpha) return order === 'asc' ? 1 : -1;
      return order === 'asc'
        ? a.localeCompare(b, "ja")
        : b.localeCompare(a, "ja");
    };
    return Object.entries(stats).sort((a, b) =>
      naturalSort(a[0], b[0], sort === 'name-asc' ? 'asc' : 'desc')
    );
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
    { id: 'search', content: safeTranslate('tabs.search', 'Search') },
    { id: 'product', content: safeTranslate('tabs.product', 'Product') },
    { id: 'status', content: safeTranslate('tabs.status', 'Status') },
  ];
  const selectedTab = Math.max(0, tabs.findIndex(tab => tab.id === detailViewMode));

  // OCRUploader用のコールバック関数 - 新しい出荷データが保存された時にリフレッシュ
  const handleOcrSaveSuccess = () => {
    fetchShipments(shopId);
  };

  const filteredAndSortedShipments = shipments
  .filter(s => (s.items || []).some(item => item.name === hoveredProduct))
  .sort((a, b) => {
    // まずstatus順
    const aStatus = a.status ?? (t('status.notSet') ?? 'Not Set');
    const bStatus = b.status ?? (t('status.notSet') ?? 'Not Set');
    const statusDiff = statusOrder.indexOf(aStatus) - statusOrder.indexOf(bStatus);
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

    // Safe rendering checks
    const safeShipments = shipments || [];
    const safeUpcomingShipments = upcomingShipments || [];
    const safeFilteredShipments = filteredShipments || [];

  // --- JSX ---
  return (
    <ErrorBoundary FallbackComponent={AppErrorFallback}>
      <Page
        title={safeTranslate('title.shipmentsByOwner', 'Shipments by Owner')}
       
        primaryAction={<LanguageSwitcher value={lang} onChange={setLang} />}
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
                  accessibilityLabel={safeTranslate('button.showGuide', 'Show Guide')}
                >
                  {safeTranslate('button.showGuide', 'Show Guide')}
                </Button>
              </InlineStack>
            </Box>
          )}

        <Card>
        
          <BlockStack gap="400"> 
          <Text as="h2" variant="headingLg" id="card-edit">{safeTranslate('title.upcomingArrivals', 'Upcoming Arrivals')}</Text>
          {/* <Text as="p" variant="bodyMd" tone="subdued">{t('message.upcomingArrivals')}</Text>
         */}
        {safeShipments.length === 0 ? (
            <Banner tone="info">{safeTranslate('message.noData', 'No data available')}</Banner>
          ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {safeUpcomingShipments.map((s) => (
            <li key={s.si_number} style={{ cursor: 'pointer', marginBottom: '0.5rem' }}>
            <span onClick={() => setSelectedShipment(s)}>
              {s.si_number} - <strong>ETA:</strong> {s.eta || 'Not set'}
            </span>
            </li>
          ))}
        </ul>)
          }
          </BlockStack>
       
      {/* 表示切り替えボタン */}
      
       <BlockStack gap="500">
        
        <Text as="h2" variant="headingLg">{safeTranslate('title.arrivalStatus', 'Arrival Status')}</Text>
        {/* ▼▼▼ ここが変更点 ▼▼▼ */}
        <Tabs
          tabs={[
            { id: 'card', content: safeTranslate('button.cardView', 'Card View') },
            { id: 'table', content: safeTranslate('button.tableView', 'Table View') }
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
          {safeShipments.map((s) => (
             <StatusCard
             key={s.si_number}
             {...s}
             onSelectShipment={() => setSelectedShipment(s)} // 追加
           />
          ))}
        </InlineStack>
      ) : (
        <StatusTable 
        shipments={safeShipments} 
        onSelectShipment={(shipment) => setSelectedShipment(shipment)}
        />
      )}
      
      </BlockStack>
      </Card>


      
      

{/* 詳細表示　　セクション */}
<Card>
  <BlockStack gap="500">

  <Text as="h2" variant="headingLg" id="detail-section">{safeTranslate('title.detailDisplay', 'Detail Display')}</Text>


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
      <Text as="h3" variant="headingMd">{safeTranslate('title.productArrivals', 'Product Arrivals')}</Text>
          
        <Button
          onClick={() =>

            setProductStatsSort(sort =>
              sort === 'name-asc' ? 'name-desc' : 'name-asc'
            )
          }
          size="slim"
          variant="plain"
        >
          {productStatsSort === 'name-asc' ? safeTranslate('button.productNameAsc', 'Product Name (A-Z)') : safeTranslate('button.productNameDesc', 'Product Name (Z-A)')}
        </Button>
      </InlineStack>

        <DataTable
            columnContentTypes={['text', 'numeric']}
            headings={[safeTranslate('label.productName', 'Product Name'), safeTranslate('label.totalQuantity', 'Total Quantity')]}
            rows={getProductStats(safeShipments, productStatsSort).map(([name, qty]) => [
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
    <Text as="h3" variant="headingMd">{safeTranslate('title.statusChart', 'Status Chart')}</Text>
      {statusOrder.map(status => {
        const shipmentsForStatus = getStatusStats(safeShipments)[status] || [];
        const rows = shipmentsForStatus.flatMap(s =>
          (s.items || []).map(item => [
            <span
            style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setSelectedShipment(s)}
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter') setSelectedShipment(s); }}
            title={safeTranslate('message.clickForDetails', 'Click for details')}
            key={s.si_number + item.name}
          >
            {s.si_number}
          </span>, 
            item.name,
            item.quantity
          ])
        );
        return rows.length > 0 ?(
          <Box key={status} paddingBlock="400">
            <BlockStack gap="300">
            <Text as="h4" variant="headingMd">{status}</Text>
            <DataTable
              columnContentTypes={['text', 'text', 'numeric']}
              headings={[safeTranslate('label.siNumber', 'SI Number'), safeTranslate('label.productName', 'Product Name'), safeTranslate('label.quantity', 'Quantity')]}
              rows={rows}
            />
          </BlockStack>
          </Box>
        ): null;
        })}
      </BlockStack>
        )}



        {/* SI番号で検索 */}
        {detailViewMode === 'search' && (
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">{safeTranslate('title.siSearch', 'SI Search')}</Text>
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
                headings={[safeTranslate('label.siNumber', 'SI Number'), safeTranslate('label.eta', 'ETA'), safeTranslate('label.supplier', 'Supplier')]}
                rows={safeFilteredShipments.map((s, idx) => [
                  <span
                    style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
                    onClick={() => setSelectedShipment(s)}
                    key={s.si_number}
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') setSelectedShipment(s); }}
                    title={safeTranslate('message.clickForDetails', 'Click for details')}
                  >
                    {s.si_number}
                  </span>,
                  s.eta,
                  s.supplier_name
                ])}
              />
              {safeFilteredShipments.length === 0 && (
                <Banner tone="info">{safeTranslate('message.noMatchingSi', 'No matching SI numbers found')}</Banner>
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
       <div id="ocr-section" />
        <OCRUploader 
          shopId={shopId} 
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
        {/* <Text as="p" variant="bodyMd" fontWeight="semibold">
          {t('message.siListWith', { productName: hoveredProduct })}
        </Text> */}
        <Box paddingBlockStart="200">
          <DataTable
            columnContentTypes={['text', 'text', 'numeric', 'text']}
            headings={[
              safeTranslate('label.siNumber', 'SI Number'),
              safeTranslate('label.productName', 'Product Name'),
              safeTranslate('label.quantity', 'Quantity'),
              safeTranslate('label.status', 'Status')
            ]}
            rows={rows}
          />
        </Box>
      </div>
    )}
  <Box paddingBlockEnd="1200" />

      {/* モーダル表示 */}
      {selectedShipment && (
        <CustomModal
          shipment={selectedShipment}
          onClose={handleModalClose}
          onUpdated={() => fetchShipments(shopId)}
        />
      )}
    </Page>
    </ErrorBoundary>
  );
}

