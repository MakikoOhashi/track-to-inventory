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


import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useTranslation } from "react-i18next";
import { i18n } from "~/utils/i18n.server";

// --- ① LoaderでShopifyセッションからshop（Shop ID）を取得 ---
import { authenticate } from "~/shopify.server"; // ←例: Shopify Remix SDK

import { createClient } from '@supabase/supabase-js';

type StatusTableProps = {
  shipments: Shipment[];
  onSelectShipment: (shipment: Shipment) => void;
};

type StatusStats = Record<string, Shipment[]>;

type PopupPos = { x: number; y: number };


export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Shopify認証を実行（認証失敗時は例外が発生）
  const { session } = await authenticate.admin(request);
    const shop = session.shop;
  const locale = await i18n.getLocale(request);
    
    // 認証済みshop情報の検証
    if (!shop) {
      throw new Response("Unauthorized", { status: 401 });
    }
    
    // SSRでshipmentsデータを事前取得（認証済みshopのみ）
    let shipments = [];
    try {
      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
      const { data, error } = await supabase
        .from('shipments')
        .select('*')
        .eq('shop_id', shop); // 認証済みshop_idのみ使用
      
      if (error) {
        console.error('Supabase error:', error);
        // エラー時は空配列を返す（データ漏洩を防ぐ）
        shipments = [];
      } else if (data) {
        shipments = data;
      }
    } catch (error) {
      console.error('SSR shipments fetch error:', error);
      // エラー時は空配列を返す（データ漏洩を防ぐ）
      shipments = [];
    }
    
    return json({ shop, locale, shipments });
  } catch (error) {
    // 認証失敗時は401エラー
    if (error instanceof Response) {
      throw error;
    }
    console.error('Authentication error:', error);
    throw new Response("Authentication failed", { status: 401 });
  }
};


export default function Index() {
  const { shop, shipments: initialShipments, locale: initialLocale } = useLoaderData<typeof loader>();
  const { t, i18n: i18nInstance } = useTranslation();

  // 状態管理
  const [shipments, setShipments] = useState<Shipment[]>(initialShipments);
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
  const [shopId, setShopId] = useState<string>(shop || "");
  const [shopIdInput, setShopIdInput] = useState<string>(shop || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    // 状態を更新して再レンダリングをトリガー
    setLocale(newLanguage);
  };

  // データ取得関数（認証済みshop_idのみ使用）
  const fetchShipments = async (shopIdValue: string) => {
    if (!shopIdValue || shopIdValue !== shop) {
      console.error('Shop ID mismatch or invalid');
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
      console.error('Failed to fetch shipments:', err);
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
        productMap.set(name, (productMap.get(name) || 0) + (item.quantity || 0));
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

  // ステータス日本語→英語キー変換マップ
  const statusJaToKey = {
    "SI発行済": "siIssued",
    "船積スケジュール確定": "scheduleConfirmed",
    "船積中": "shipping",
    "輸入通関中": "customsClearance",
    "倉庫着": "warehouseArrival",
    "同期済み": "synced"
  };

  // statusTranslationMapの定義も関数内で
  const statusTranslationMap: Record<string, string> = {
    "SI発行済": t('modal.status.siIssued'),
    "船積スケジュール確定": t('modal.status.scheduleConfirmed'),
    "船積中": t('modal.status.shipping'),
    "輸入通関中": t('modal.status.customsClearance'),
    "倉庫着": t('modal.status.warehouseArrival'),
    "同期済み": t('modal.status.synced'),
    "siIssued": t('modal.status.siIssued'),
    "scheduleConfirmed": t('modal.status.scheduleConfirmed'),
    "shipping": t('modal.status.shipping'),
    "customsClearance": t('modal.status.customsClearance'),
    "warehouseArrival": t('modal.status.warehouseArrival'),
    "synced": t('modal.status.synced'),
    "未設定": t('status.notSet'),
  };

  const statusOrder = [
    t('modal.status.siIssued'),
    t('modal.status.scheduleConfirmed'),
    t('modal.status.shipping'),
    t('modal.status.customsClearance'),
    t('modal.status.warehouseArrival'),
    t('status.productSync'),
    t('modal.status.synced')
  ];

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
    const statusDiff = statusOrder.indexOf(a.status ?? t('status.notSet')) - statusOrder.indexOf(b.status ?? t('status.notSet'));
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
        s.status
      ];
    });

    

  // --- JSX ---
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
    
      {statusOrder.map((status, index) => {
        const shipmentsForStatus = getStatusStats(shipments)[status] || [];
        
        const rows = shipmentsForStatus.flatMap(s =>
          (s.items || []).map(item => [
            <span
            style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setSelectedShipment(s)}
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter') setSelectedShipment(s); }}
            title={t('message.clickForDetails')}
            key={s.si_number + (item.name || 'unknown')}
          >
            {s.si_number}
          </span>, 
            item.name || 'Unknown',
            item.quantity || 0,
            // ステータスを翻訳して表示
            (() => {
              if (s.status === "siIssued") return t('modal.status.siIssued');
              if (s.status === "scheduleConfirmed") return t('modal.status.scheduleConfirmed');
              if (s.status === "shipping") return t('modal.status.shipping');
              if (s.status === "customsClearance") return t('modal.status.customsClearance');
              if (s.status === "warehouseArrival") return t('modal.status.warehouseArrival');
              if (s.status === "productSync") return t('status.productSync');
              if (s.status === "synced") return t('modal.status.synced');
              return s.status || t('status.notSet');
            })()
          ])
        );
        
        return rows.length > 0 ?(
          <Box key={status} paddingBlock="400">
            <BlockStack gap="300">
            <Text as="h4" variant="headingMd">
              {(() => {
                // 英語のステータスを翻訳して表示
                if (status === "siIssued") return t('modal.status.siIssued');
                if (status === "scheduleConfirmed") return t('modal.status.scheduleConfirmed');
                if (status === "shipping") return t('modal.status.shipping');
                if (status === "customsClearance") return t('modal.status.customsClearance');
                if (status === "warehouseArrival") return t('modal.status.warehouseArrival');
                if (status === "productSync") return t('status.productSync');
                if (status === "synced") return t('modal.status.synced');
                return status;
              })()}
            </Text>
            <DataTable
              columnContentTypes={['text', 'text', 'numeric', 'text']}
              headings={[t('label.siNumber'), t('label.productName'), t('label.quantity'), t('label.status')]}
              rows={rows}
            />
          </BlockStack>
          </Box>
        ): (
          <Box key={status} paddingBlock="400">
            <Text as="h4" variant="headingMd">{t('status.noData')}</Text>
            <Banner tone="info">このステータスにはデータがありません</Banner>
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
       <div id="ocr-section" />
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
      <CustomModal
        shipment={selectedShipment}
        onClose={handleModalClose}
        onUpdated={() => fetchShipments(shop)}
      />
    </Page>
  );
}

