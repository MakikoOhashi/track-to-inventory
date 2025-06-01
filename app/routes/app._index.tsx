//app/routes/_index.tsx

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
} from '@shopify/polaris';
import CustomModal from '../components/Modal';
import StatusCard from '../components/StatusCard';
import StatusTable from '../components/StatusTable';
import OCRUploader from "../components/OCRUploader";
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';


// 型定義
type ShipmentItem = {
  name: string;
  quantity: number;
};

type Shipment = {
  si_number: string;
  eta: string;
  supplier_name: string;
  // 他に必要なプロパティも追加
  items: ShipmentItem[];
  status?: string;
};

type StatusStats = Record<string, Shipment[]>;

type PopupPos = { x: number; y: number };

// i18n（仮対応、Remixでの正式なi18n構成に合わせて修正要）
const t = (key: string, _opt?: any) => key; // 仮: すべてkey返す

export default function Index() {
  const [shopIdInput, setShopIdInput] = useState<string>("test-owner");
  const [shopId, setShopId] = useState<string>("test-owner");
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [hoveredProduct, setHoveredProduct] = useState<string | null>(null);
  const [popupPos, setPopupPos] = useState<PopupPos>({ x: 0, y: 0 });
  const [productStatsSort, setProductStatsSort] = useState<'name-asc' | 'name-desc'>('name-asc');
  const [detailViewMode, setDetailViewMode] = useState<'product' | 'status' | 'search'>('product');
  const [siQuery, setSiQuery] = useState<string>('');


  const popupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const POPUP_WIDTH = 320;
  const POPUP_HEIGHT = 180;

  // ステータスの翻訳マッピング
  const statusTranslationMap: Record<string, string> = {
    "SI発行済": t('status.siIssued'),
    "船積スケジュール確定": t('status.scheduleConfirmed'),
    "船積中": t('status.shipping'),
    "輸入通関中": t('status.customsClearance'),
    "倉庫着": t('status.warehouseArrived'),
    "未設定": t('status.notSet'),
  };


  const statusOrder = ["SI発行済", "船積スケジュール確定", "船積中", "輸入通関中", "倉庫着"];
  const [lang, setLang] = useState("ja"); // 例: 最初は日本語

  // 修正1: supabaseで直接取得→API経由に変更
  const fetchShipments = async (shopIdValue: string) => {
    const res = await fetch(`/api/shipments?shop_id=${encodeURIComponent(shopIdValue)}`);
    if (!res.ok) {
      setShipments([]);
      return;
    }
    const json = await res.json();
    setShipments(Array.isArray(json.data) ? json.data : []);
  };

  // --- 修正2: useEffectでshopIdが変わった時だけfetchShipments実行 ---
  useEffect(() => {
    fetchShipments(shopId);
  }, [shopId]);

  // --- 修正3: fetchData（全件取得関数）を削除し、handleModalCloseでshopIdで再取得 ---
  const handleModalClose = () => {
    setSelectedShipment(null);
    fetchShipments(shopId); // ← 閉じたあともshopIdで絞り込んだデータを取得
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
      const status = s.status || "未設定";
      if (!stats[status]) stats[status] = [];
      stats[status].push(s);
    });
    return stats;
  };

  const handleProductMouseEnter = (e: MouseEvent<HTMLElement>, name: string) => {
    if (popupTimeout.current) clearTimeout(popupTimeout.current);
    const rect = e.currentTarget.getBoundingClientRect();
    let x = rect.right + window.scrollX + 10;
    let y = rect.top + window.scrollY + 10;


    // 右端はみ出し防止
    if (x + POPUP_WIDTH > window.innerWidth) {
      x = window.innerWidth - POPUP_WIDTH - 10;
    }
    // 下端はみ出し防止
    if (y + POPUP_HEIGHT > window.innerHeight) {
      y = window.innerHeight - POPUP_HEIGHT - 10;
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
    .sort((a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime())
    .slice(0, 2);
    
  // Polaris用タブ
  const tabs = [
    { id: 'search', content: t('tabs.search') },
    { id: 'product', content: t('tabs.product') },
    { id: 'status', content: t('tabs.status') },
  ];
  const selectedTab = tabs.findIndex(tab => tab.id === detailViewMode);

  // OCRUploader用のコールバック関数 - 新しい出荷データが保存された時にリフレッシュ
  const handleOcrSaveSuccess = () => {
    fetchShipments(shopId);
  };

  const filteredAndSortedShipments = shipments
    .filter(s => (s.items || []).some(item => item.name === hoveredProduct))
    .sort((a, b) => {
      // まずstatus順
      const statusDiff = statusOrder.indexOf(a.status ?? "未設定") - statusOrder.indexOf(b.status ?? "未設定");
      if (statusDiff !== 0) return statusDiff;
      // 同じstatusならETA順
      return new Date(a.eta).getTime() - new Date(b.eta).getTime();
    });

  const rows = filteredAndSortedShipments.map(s => {
    const item = (s.items || []).find(item => item.name === hoveredProduct);
    return [
      s.si_number,
      item?.name ?? '',         // itemがundefinedのとき空文字に
      item?.quantity ?? '',     // itemがundefinedのとき空文字に
      s.status
    ];
  });

  // --- JSX ---
  return (
    <>
      <Page title={t('title.shipmentsByOwner')}>
        
        <Card>
        <BlockStack>
          {/* 言語切り替え */}
          <div style={{ marginBottom: 16 }}>
            <LanguageSwitcher 
              value={lang}
              onChange={setLang}
            />
          </div>
          
          <TextField
            label={t('label.shopId')}
            value={shopIdInput}
            onChange={handleInputChange}
            autoComplete="off"
            placeholder={t('placeholder.shopId')}
          />
          <Button variant="primary" onClick={handleShopIdApply} style={{ marginTop: 16 }}>
          {t('button.switch')}
          </Button>
          </BlockStack> 
        </Card>
       
        {/* ETAが近い上位2件のリスト表示 */}     
        <Card>
        
          <BlockStack> 
          <Text as="h2" variant="headingLg">{t('title.upcomingArrivals')}</Text>
        <p>{t('message.upcomingArrivals')}</p>
        {shipments.length === 0 ? (
            <p>{t('message.noData')}</p>
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
        </Card>
        
      </Page>
    

    <Page title={t('title.arrivalStatus')}>
      
        {/* ここにOCRアップローダーを追加 - shopIdを渡す */}
        <OCRUploader 
          shopId={shopId} 
          onSaveSuccess={handleOcrSaveSuccess}
        />
      
      {/* 表示切り替えボタン */}
       <Card>
       <BlockStack>
        
        <ButtonGroup>
          <Button 
          variant={viewMode === 'card' ? 'primary' : 'secondary'} 
          onClick={() => setViewMode('card')}>
            {t('button.cardView')}
          </Button>
          <Button
            variant={viewMode === 'table' ? 'primary' : 'secondary'}
            onClick={() => setViewMode('table')}
          >
    {t('button.tableView')}
  </Button>
        </ButtonGroup>
      

      {/* 表示形式に応じて切り替え */}
      
      {viewMode === 'card' ? (
        <InlineStack gap="400">
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
  <BlockStack gap="400">

  <Text as="h2" variant="headingLg">{t('title.detailDisplay')}</Text>

  <ButtonGroup>
    <Button 
      variant={detailViewMode === 'search' ? "primary" : "secondary"}
      onClick={() => setDetailViewMode('search')}
    >
      {t('button.searchBySi')}
    </Button>
    <Button 
       variant={detailViewMode === 'product' ? "primary" : "secondary"}
       onClick={() => setDetailViewMode('product')}
    >
       {t('button.productArrivals')}
    </Button>
    <Button 
      variant={detailViewMode === 'status' ? "primary" : "secondary"}
      onClick={() => setDetailViewMode('status')}
    >
      {t('button.statusChart')}
    </Button>
  </ButtonGroup>
  {/* ←この下にトグルで統計表を追加 */}
  
    <div style={{ 
      marginTop: 16, 
      background: "#fff", 
      border: "1px solid #ccc", 
      borderRadius: 6, 
      padding: 16, 
      maxWidth: 480, 
      marginLeft: "auto", 
      marginRight: "auto", 
      position: "relative" 
    }}>
       {/* 商品別 */}
       {detailViewMode === 'product' && (
      <>
      <Text as="h3" variant="headingMd">{t('title.productArrivals')}</Text>
      <div style={{ marginBottom: 12 }}>        
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
      </div>
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
     
      {/* POPUP */}
      { hoveredProduct && (
        <div
          style={{
            position: "fixed",
            top: popupPos.y,
            left: popupPos.x,
            background: "#fff",
            border: "1px solid #aaa",
            borderRadius: "6px",
            boxShadow: "0 2px 8px #aaa",
            padding: "12px",
            zIndex: 99999,
            minWidth: `${POPUP_WIDTH}px`,
            maxWidth: `${POPUP_WIDTH}px`,
            maxHeight: `${POPUP_HEIGHT}px`,
            overflowY: "auto",
            fontSize: "0.95em"
          }}
          onMouseEnter={handlePopupMouseEnter}
          onMouseLeave={handlePopupMouseLeave}
        >
          <b>{t('message.siListWith', { productName: hoveredProduct })}</b>
          <DataTable
            columnContentTypes={['text', 'text', 'numeric', 'text']}
            headings={[
              t('label.siNumber'),
              t('label.productName'),
              t('label.quantity'),
              t('label.status')
            ]}
            rows={rows}
            onRowClick={(_row, index) => {
              setSelectedShipment(filteredAndSortedShipments[index]);
            }}
          />
        </div>
      )}
    </>
    )}

     {/* ステータスごとのチャート */}
     {detailViewMode === 'status' && (
    <>
    <Text as="h3" variant="headingMd">{t('title.statusChart')}</Text>
      {statusOrder.map(status => {
        const shipmentsForStatus = getStatusStats(shipments)[status] || [];
        const rows = shipmentsForStatus.flatMap(s =>
          (s.items || []).map(item => [
            <span
            style={{ color: "#2a5bd7", cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setSelectedShipment(s)}
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter') setSelectedShipment(s); }}
            title={t('message.clickForDetails')}
            key={s.si_number + item.name}
          >
            {s.si_number}
          </span>, 
            item.name,
            item.quantity
          ])
        );
        return (
          <div key={status} style={{ marginBottom: 16 }}>
            <Text as="h4" variant="headingMd">{status}</Text>
            <DataTable
              columnContentTypes={['text', 'text', 'numeric']}
              headings={[t('label.siNumber'), t('label.productName'), t('label.quantity')]}
              rows={rows}
            />
          </div>
        );
        })}
          </>
        )}



        {/* SI番号で検索 */}
        {detailViewMode === 'search' && (
            <>
              <Text as="h3" variant="headingMd">{t('title.siSearch')}</Text>
              <TextField
                label={t('label.siNumber')}
                value={siQuery}
                onChange={setSiQuery}
                autoComplete="off"
                placeholder={t('placeholder.siNumber')}
                clearButton
                onClearButtonClick={() => setSiQuery('')}
              />
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
              {siQuery && filteredShipments.length === 0 && (
                <Banner tone="info">{t('message.noMatchingSi')}</Banner>
              )}
            </>
            )}
    </div>
  
      {/* モーダル表示 */}
      <CustomModal
        shipment={selectedShipment}
        onClose={handleModalClose}
      />
      </BlockStack>
    </Card>  
    </Page>
  </>
  );
}

