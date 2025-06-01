//app/routes/_index.tsx


// src/App.jsxからの移植
import React, { useEffect, useState, useRef } from 'react';
import { AppProvider,Page, Card, Button, ButtonGroup, DataTable, TextField, Tabs, Banner, InlineStack, BlockStack, TextContainer, Text } from '@shopify/polaris';
//import { useTranslation } from 'next-i18next';
//import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import CustomModal from '../components/Modal';
import StatusCard from '../components/StatusCard';
import StatusTable from '../components/StatusTable';
import OCRUploader from "../components/OCRUploader";
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';

// i18n（仮対応、Remixでの正式なi18n構成に合わせて修正要）
const t = (key) => key; // 仮: すべてkey返す

export default function Index() {
  const [shopIdInput, setShopIdInput] = useState("test-owner");
  const [shopId, setShopId] = useState("test-owner");
  const [viewMode, setViewMode] = useState('card');
  const [selectedShipment, setSelectedShipment] = useState(null);
  const [shipments, setShipments] = useState([]);
  const [hoveredProduct, setHoveredProduct] = useState(null); // { name, x, y }
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 });
  const [productStatsSort, setProductStatsSort] = useState('name-asc'); // 'name-asc' or 'name-desc'
  const [detailViewMode, setDetailViewMode] = useState('product'); // 'product', 'status', 'search'
  const [siQuery, setSiQuery] = useState('');

  const popupTimeout = useRef(null);
  const POPUP_WIDTH = 320;
  const POPUP_HEIGHT = 180;

  // ステータスの翻訳マッピング
  const statusTranslationMap = {
    "SI発行済": t('status.siIssued'),
    "船積スケジュール確定": t('status.scheduleConfirmed'),
    "船積中": t('status.shipping'),
    "輸入通関中": t('status.customsClearance'),
    "倉庫着": t('status.warehouseArrived'),
    "未設定": t('status.notSet')
  };

  const statusOrder = ["SI発行済", "船積スケジュール確定", "船積中", "輸入通関中", "倉庫着"];

  // 修正1: supabaseで直接取得→API経由に変更
  const fetchShipments = async (shopIdValue) => {
    const res = await fetch(`/api/shipments?shop_id=${encodeURIComponent(shopIdValue)}`);
    if (!res.ok) {
      setShipments([]);
      return;
    }
    const json = await res.json();
    setShipments(json.data || []);
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

  const handleInputChange = (value) => setShopIdInput(value);
  const handleShopIdApply = () => setShopId(shopIdInput);

  // SI番号で検索用（前方一致・上位10件）
  const filteredShipments = shipments
  .filter(s =>
    !siQuery ||
    (s.si_number && s.si_number.toLowerCase().startsWith(siQuery.toLowerCase())) 
  )
  .slice(0, 10);
  // ステータスごとグループ化関数
  const getStatusStats = (shipments) => {
    const stats = {};
    shipments.forEach(s => {
      const status = s.status || "未設定";
      if (!stats[status]) stats[status] = [];
      stats[status].push(s);
    });
    return stats;
  };

  const handleProductMouseEnter = (e, name) => {
    if (popupTimeout.current) clearTimeout(popupTimeout.current);
    const rect = e.target.getBoundingClientRect();
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

  const getProductStats = (shipments, sort = 'name-asc') => {
    const stats = {};
    shipments.forEach(s => {
      (s.items || []).forEach(item => {
        if (!item.name) return;
        stats[item.name] = (stats[item.name] || 0) + Number(item.quantity || 0);
      });
    });
   // 数字→アルファベット→その他
    const naturalSort = (a, b, order) => {
      // 1. 数字から始まるものを最優先
      const aIsNum = /^\d/.test(a);
      const bIsNum = /^\d/.test(b);
      if (aIsNum && !bIsNum) return order === 'asc' ? -1 : 1;
      if (!aIsNum && bIsNum) return order === 'asc' ? 1 : -1;
      if (aIsNum && bIsNum) {
        // どちらも数字で始まる場合、数値として比較
        const aNum = parseInt(a.match(/^\d+/)[0], 10);
        const bNum = parseInt(b.match(/^\d+/)[0], 10);
        if (aNum !== bNum) return order === 'asc' ? aNum - bNum : bNum - aNum;
        // 数字部分が同じ場合は文字列比較
        return order === 'asc' ? a.localeCompare(b, "ja") : b.localeCompare(a, "ja");
      }
      // 2. アルファベットで始まるものを次に
      const aIsAlpha = /^[a-zA-Z]/.test(a);
      const bIsAlpha = /^[a-zA-Z]/.test(b);
      if (aIsAlpha && !bIsAlpha) return order === 'asc' ? -1 : 1;
      if (!aIsAlpha && bIsAlpha) return order === 'asc' ? 1 : -1;
      // 3. その他はlocaleCompare
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
    .sort((a, b) => new Date(a.eta) - new Date(b.eta))
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


  // --- JSX ---
  return (
    <>
      <Page title={t('title.shipmentsByOwner')}>
        
        <Card sectioned>
          {/* 言語切り替え */}
          <div style={{ marginBottom: 16 }}>
            <LanguageSwitcher />
          </div>
          
          <TextField
            label={t('label.shopId')}
            value={shopIdInput}
            onChange={handleInputChange}
            autoComplete="off"
            placeholder={t('placeholder.shopId')}
          />
          <Button primary onClick={handleShopIdApply} style={{ marginTop: 16 }}>
          {t('button.switch')}
          </Button>
          
        </Card>
       
        {/* ETAが近い上位2件のリスト表示 */}     
        <Card title={t('title.upcomingArrivals')} sectioned>
        
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
          
        </Card>
        
      </Page>
    

    <Page title={t('title.arrivalStatus')}>
      
        {/* ここにOCRアップローダーを追加 - shopIdを渡す */}
        <OCRUploader 
          shopId={shopId} 
          onSaveSuccess={handleOcrSaveSuccess}
        />
      
      {/* 表示切り替えボタン */}
       <Card sectioned>
        
        <ButtonGroup>
          <Button primary={viewMode === 'card'} onClick={() => setViewMode('card')}>{t('button.cardView')}</Button>
          <Button primary={viewMode === 'table'} onClick={() => setViewMode('table')}>{t('button.tableView')}</Button>
        </ButtonGroup>
      

      {/* 表示形式に応じて切り替え */}
      
      {viewMode === 'card' ? (
        <InlineStack gap="loose">
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
      </Card>


      
      

{/* 詳細表示　　セクション */}
<Card sectioned>
  <Text as="h2" variant="headingLg">{t('title.detailDisplay')}</Text>

  <ButtonGroup>
    <Button primary={detailViewMode === 'search'}
      onClick={() => setDetailViewMode('search')}
    >
      {t('button.searchBySi')}
    </Button>
    <Button primary={detailViewMode === 'product'}
      onClick={() => setDetailViewMode('product')}
    >
       {t('button.productArrivals')}
    </Button>
    <Button primary={detailViewMode === 'status'}
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
          plain
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
            headings={[t('label.siNumber'), t('label.productName'), t('label.quantity'), t('label.status')]}
            rows={
              shipments
                .filter(s => (s.items || []).some(item => item.name === hoveredProduct))
                .sort((a, b) => {
                  // まずstatus順
                  const statusDiff = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
                  if (statusDiff !== 0) return statusDiff;
                  // 同じstatusならETA順
                  return new Date(a.eta) - new Date(b.eta);
                })
                .map(s => {
                  const item = (s.items || []).find(item => item.name === hoveredProduct);
                  return [
                    s.si_number,
                    item.name,
                    item.quantity,
                    s.status
                  ];
                })
                }
                onRowClick={(_row, index) => {
                const siShipments = shipments
                    .filter(s => (s.items || []).some(item => item.name === hoveredProduct))
                    .sort((a, b) => {
                        // まずstatus順
                    const statusDiff = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
                    if (statusDiff !== 0) return statusDiff;
                    // 同じstatusならETA順
                    return new Date(a.eta) - new Date(b.eta);
                    });
                setSelectedShipment(siShipments[index]);
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
                <Banner status="info">{t('message.noMatchingSi')}</Banner>
              )}
            </>
            )}
    </div>
  
      {/* モーダル表示 */}
      <CustomModal
        shipment={selectedShipment}
        onClose={handleModalClose}
      />
    </Card>  
    </Page>
  </>
  );
}

