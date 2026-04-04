// app/components/Modal.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  Button,
  TextField,
  Select,
  Checkbox,
  InlineStack,
  BlockStack,
  Text,
  Banner
} from '@shopify/polaris';
import ShopifyVariantSelector from './ShopifyVariantSelector';

// ステータスの英語キーと日本語の変換マップ
const statusJaToKey = {
  "SI発行済": "siIssued",
  "船積スケジュール確定": "scheduleConfirmed",
  "船積中": "shipping",
  "輸入通関中": "customsClearance",
  "倉庫着": "warehouseArrival",
  "同期済み": "synced"
};

const statusKeyToJa = Object.fromEntries(Object.entries(statusJaToKey).map(([ja, key]) => [key, ja]));

const CustomModal = ({
  shipment,
  onClose,
  onUpdated,
  shopifyProducts = [],
  shopifyProductsLoading = false,
  shopifyProductsError = "",
  locale = "ja",
}) => {
  const { t, i18n } = useTranslation();
  const effectiveLocale = (locale || i18n.language || "ja").toLowerCase();
  
  // FILE_TYPESの定義を修正
  const FILE_TYPES = [
    { key: 'invoice', label: t('modal.fileTypes.invoice') },
    { key: 'pl', label: t('modal.fileTypes.pl') },
    { key: 'si', label: t('modal.fileTypes.si') },
    { key: 'other', label: t('modal.fileTypes.other') }
  ];
  
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signedUrlCache, setSignedUrlCache] = useState({});
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedItems, setSelectedItems] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState([]);

  // ステータスオプションを英語キーで統一
  const STATUS_OPTIONS = [
    { label: t('modal.status.siIssued'), value: "siIssued" },
    { label: t('modal.status.scheduleConfirmed'), value: "scheduleConfirmed" },
    { label: t('modal.status.shipping'), value: "shipping" },
    { label: t('modal.status.customsClearance'), value: "customsClearance" },
    { label: t('modal.status.warehouseArrival'), value: "warehouseArrival" },
    { label: t('modal.status.synced'), value: "synced" },
  ];

  // 初期化時の処理
  useEffect(() => {
    if (!shipment) {
      // 初期状態では何も表示しない（これは正常な動作）
      return;
    }
    
    // shipmentデータが提供された場合の処理
    setFormData({
      si_number: shipment.si_number || '',
      eta: shipment.eta || '',
      supplier_name: shipment.supplier_name || '',
      status: shipment.status || '',
      items: shipment.items || [],
      memo: shipment.memo || '',
      invoice_url: shipment.invoice_url || '',
      pl_url: shipment.pl_url || '',
      si_url: shipment.si_url || '',
      other_url: shipment.other_url || ''
    });
    
    setSelectedStatus(shipment.status || '');
    setSelectedItems(shipment.items || []);
    setSelectedFiles({
      invoice: shipment.invoice_url || '',
      pl: shipment.pl_url || '',
      si: shipment.si_url || '',
      other: shipment.other_url || ''
    });
    
  }, [shipment]);

  // ファイルの署名付きURLを一括取得
  const loadSignedUrls = useCallback(async () => {
    if (!formData?.si_number) return;

    const fileFields = ['invoice_url', 'pl_url', 'si_url', 'other_url'];
    const filePaths = fileFields
      .map(field => formData[field])
      .filter(path => path && !path.includes('token=')); // 既に署名付きURLの場合は除外

    if (filePaths.length === 0) return;

    try {
      console.log('Loading signed URLs for files:', filePaths);
      
      const res = await fetch('/api/get-file-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          filePaths,
          siNumber: formData.si_number,
          shop_id: shipment.shop_id || formData.shop_id,
        })
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('Failed to get signed URLs:', res.status, errorData);
        return;
      }
      
      const json = await res.json();
      if (json.signedUrls) {
        setSignedUrlCache(prev => ({ ...prev, ...json.signedUrls }));
        console.log('Cached signed URLs:', Object.keys(json.signedUrls));
      }
      
      if (json.errors) {
        console.warn('Some signed URLs failed to generate:', json.errors);
      }
    } catch (error) {
      console.error('Error loading signed URLs:', error);
    }
  }, [formData?.si_number, formData?.invoice_url, formData?.pl_url, formData?.si_url, formData?.other_url]);

  // フォームデータが変更された時に署名付きURLを再取得
  useEffect(() => {
    loadSignedUrls();
  }, [loadSignedUrls]);

  // ファイル表示用のsigned URL取得関数（キャッシュ優先）
  const getSignedUrl = useCallback(async (filePath) => {
    if (!filePath) {
      console.error('Empty file path provided');
      return null;
    }

    // 既に署名付きURLの場合は有効期限をチェック
    if (filePath.includes('token=')) {
      try {
        const url = new URL(filePath);
        const token = url.searchParams.get('token');
        if (token) {
          // トークンの有効期限をチェック（簡易的な実装）
          // 実際の実装では、JWTトークンのexpクレームをデコードする必要があります
          return filePath;
        }
      } catch (error) {
        console.error('URL parsing error:', error);
      }
    }

    // キャッシュから取得を試行
    if (signedUrlCache[filePath]) {
      console.log('Using cached signed URL for:', filePath);
      return signedUrlCache[filePath];
    }

    // キャッシュにない場合は個別取得
    try {
      console.log('Requesting signed URL for file path:', filePath);

      const res = await fetch('/api/get-file-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          filePaths: [filePath],
          siNumber: formData?.si_number,
          shop_id: shipment.shop_id || formData?.shop_id,
        })
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('Failed to get signed URL:', res.status, errorData);
        throw new Error(`Failed to get signed URL: ${errorData.error || res.statusText}`);
      }
      
      const json = await res.json();
      if (json.signedUrl) {
        // キャッシュに保存
        setSignedUrlCache(prev => ({ ...prev, [filePath]: json.signedUrl }));
        console.log('Successfully received and cached signed URL');
        return json.signedUrl;
      } else {
        console.error('No signed URL in response');
        return null;
      }
    } catch (error) {
      console.error('Error getting signed URL:', error);
      return null;
    }
  }, [signedUrlCache, formData?.si_number]);

  // ファイル表示ボタンのクリックハンドラー
  const handleFileView = async (filePath, fileType) => {
    if (!filePath) {
      alert(`${fileType}ファイルが設定されていません`);
      return;
    }

    try {
      const signedUrl = await getSignedUrl(filePath);
      if (signedUrl) {
        window.open(signedUrl, '_blank');
      } else {
        alert(`${fileType}ファイルの表示に失敗しました`);
      }
    } catch (error) {
      console.error('File view error:', error);
      alert(`${fileType}ファイルの表示に失敗しました: ${error.message}`);
    }
  };

  // データ検証 - shipmentがnullの場合は何も表示しない（正常な状態）
  if (!shipment) {
    return null; // 初期状態では何も表示しない
  }
  
  if (!formData) {
    console.warn('Modal: No formData available');
    return null;
  }
  
  if (!formData.si_number) {
    console.warn('Modal: No si_number in formData:', formData);
    return null;
  }

  // --- Shopify同期アクション ---
  const handleSyncShopify = async () => {
    setSyncing(true);
    try {
      // variant_idが設定されているアイテムのみをフィルタリング
      const itemsWithVariantId = (shipment.items || []).filter(item => item.variant_id);
      
      if (itemsWithVariantId.length === 0) {
        throw new Error('同期する商品にShopify variant IDが設定されていません。商品を選択してください。');
      }

      // 1. Shopify同期API呼び出し
      const res = await fetch('/api/sync-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: itemsWithVariantId,
          shop_id: shipment.shop_id || formData.shop_id,
          locale: effectiveLocale,
        })
      });
      
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`同期に失敗しました: HTTP ${res.status} - ${errorText}`);
      }
      
      const json = await res.json();
      if (json.error) throw new Error(json.error);

      // 結果の確認
      if (json.results && json.results.length > 0) {
        const failedItems = json.results.filter(result => result.error);
        if (failedItems.length > 0) {
          const errorMessages = failedItems.map(item => 
            `${item.variant_id}: ${item.error}`
          ).join('\n');
          throw new Error(`一部の商品の同期に失敗しました:\n${errorMessages}`);
        }
      }

      // 2. ステータスを「同期済み」に更新
      const updateRes = await fetch('/api/updateShipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipment: { ...formData, status: "synced" },
          shop_id: shipment.shop_id || formData.shop_id,
        }),
      });
      if (!updateRes.ok) throw new Error(t('modal.messages.statusUpdateFailed'));
      setFormData(prev => ({ ...prev, status: "synced" }));
      alert(t('modal.messages.syncSuccess'));
      // 3. モーダル閉じる or 親にデータ更新通知
      setSyncing(false);
      if (onUpdated) onUpdated();
      onClose();
    } catch (e) {
      setSyncing(false);
      alert(e.message || t('modal.messages.syncGeneralFailed'));
    }
  };

  // --- 保存処理 ---
  const handleSave = async () => {
    if (!formData) return;
    
    setSaving(true);
    try {
      // created_at, updated_atフィールドを除外してデータを準備
      const { created_at, updated_at, ...saveData } = formData;
      // si_number以外はnullでもOK。date型は空文字列ならnullに変換
      const cleanDate = v => v === "" ? null : v;
      saveData.etd = cleanDate(saveData.etd);
      saveData.eta = cleanDate(saveData.eta);
      saveData.clearance_date = cleanDate(saveData.clearance_date);
      saveData.arrival_date = cleanDate(saveData.arrival_date);
      // 他のフィールドも空文字列ならnullにしたい場合はここで追加可能
      
      const res = await fetch('/api/updateShipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipment: saveData,
          shop_id: shipment.shop_id || saveData.shop_id,
          locale: effectiveLocale,
        }),
      });
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error('Save failed with status:', res.status, 'Response:', errorText);
        alert(`保存に失敗しました: HTTP ${res.status} - ${errorText}`);
        return;
      }
      
      const json = await res.json();
      console.log('Response JSON:', json);
      
      if (json.error) {
        console.error('Save failed with error:', json.error);
        alert(`保存に失敗しました: ${json.error}`);
        return;
      }
      
      console.log('Save successful:', json);
      alert(t('modal.messages.saveSuccess'));
      setEditMode(false);
      if (onUpdated) onUpdated();
    } catch (error) {
      console.error('Save error:', error);
      alert(`保存に失敗しました: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

   // ファイルアップロード処理
   const handleFileUpload = async (e, fileType) => {
    const file = e.target.files[0];
    if (!file) return;

    // SI番号の確認
    if (!formData?.si_number) {
      alert('SI番号が設定されていません。先にSI番号を入力してください。');
      return;
    }

    try {
      const uploadFormData = new FormData();
      uploadFormData.append('file', file);
      uploadFormData.append('si_number', formData.si_number);
      uploadFormData.append('type', fileType);
      uploadFormData.append('locale', effectiveLocale);

      console.log('Uploading file:', {
        fileName: file.name,
        fileSize: file.size,
        siNumber: formData.si_number,
        fileType: fileType
      });

      const res = await fetch('/api/uploadShipmentFile', {
        method: 'POST',
        body: uploadFormData,
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'ファイルアップロードに失敗しました');
      }
      
      const data = await res.json();
      console.log('Upload response:', data);
      
      // 署名付きURLをデータベースに保存
      const updatedFormData = { ...formData };
      updatedFormData[`${fileType}_url`] = data.signedUrl; // 署名付きURLを保存
      
      console.log('Updating database with:', updatedFormData);
      
      // created_at, updated_atフィールドを除外してデータベースを更新
      const { created_at, updated_at, ...cleanFormData } = updatedFormData;
      // 日付型フィールドをnull変換
      const cleanDate = v => v === "" ? null : v;
      cleanFormData.etd = cleanDate(cleanFormData.etd);
      cleanFormData.eta = cleanDate(cleanFormData.eta);
      cleanFormData.clearance_date = cleanDate(cleanFormData.clearance_date);
      cleanFormData.arrival_date = cleanDate(cleanFormData.arrival_date);
      
      // データベースを更新
      const updateRes = await fetch('/api/updateShipment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipment: cleanFormData,
          shop_id: shipment.shop_id || cleanFormData.shop_id,
          locale: effectiveLocale,
        }),
        });
        
      if (!updateRes.ok) {
        const updateErrorData = await updateRes.json().catch(() => ({}));
        throw new Error(updateErrorData.error || 'データベースの更新に失敗しました');
      }

      // フォームデータを更新
      setFormData(updatedFormData);
      
      // 署名付きURLをキャッシュに追加
      setSignedUrlCache(prev => ({ 
        ...prev, 
        [data.filePath]: data.signedUrl 
      }));

      alert(t('modal.messages.fileUploadSuccess'));

    } catch (error) {
      console.error('File upload error:', error);
      alert(error.message || t('modal.messages.fileUploadFailed'));
    }
  };

  // ファイル削除API呼び出し
  const handleFileDelete = async (type) => {
    if (!window.confirm(t('modal.messages.deleteFileConfirm'))) return;
    setDeleting(true);
    try {
      const formData = new FormData();
      formData.append('siNumber', shipment.si_number);
      formData.append('fileType', type);
      formData.append('locale', effectiveLocale);
    
      // shopパラメータをURLに追加（認証fallback用）
      const url = new URL('/api/deleteShipmentFile', window.location.origin);
      url.searchParams.append('shop_id', shipment.shop_id);
      url.searchParams.append('locale', effectiveLocale);
      
      const res = await fetch(url.toString(), {
        method: 'DELETE',
        body: formData,
      });
      
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      
      alert(t('modal.messages.deleteFileSuccess'));
      if (onUpdated) onUpdated();
    } catch (e) {
      console.error('File delete error:', e);
      alert(e.message || t('modal.messages.deleteFileFailed'));
    } finally {
      setDeleting(false);
    }
  };

  // 既存データが日本語の場合は変換
  const statusKey = statusJaToKey[shipment.status] || shipment.status;

  // handleDeleteを修正
  const handleDelete = async () => {
    if (!window.confirm(t('modal.messages.deleteShipmentConfirm'))) return;
    setDeleting(true);
    try {
      const formData = new FormData();
      formData.append('siNumber', shipment.si_number);
      formData.append('locale', effectiveLocale);
      
      // shopパラメータをURLに追加（認証fallback用）
      const url = new URL('/api/delete-shipment', window.location.origin);
      url.searchParams.append('shop_id', shipment.shop_id);
      url.searchParams.append('locale', effectiveLocale);
      
      const res = await fetch(url.toString(), {
        method: 'DELETE',
        body: formData,
      });
      
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.error === "DELETE_LIMIT_EXCEEDED" || res.status === 403) {
          throw new Error(t("modal.messages.freePlanRestriction"));
        }
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      if (json.error) throw new Error(json.error);
      
      alert(t('modal.messages.deleteSuccess'));
      if (onUpdated) onUpdated();
      onClose();
    } catch (e) {
      console.error('Delete error:', e);
      alert(e.message || t('modal.messages.deleteGeneralFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={!!shipment}
      onClose={onClose}
      title={`${t('modal.title')}: ${shipment?.si_number || ""}`}
      primaryAction={editMode
        ? { content: `💾 ${t('modal.buttons.save')}`, onAction: handleSave }
        : { content: `✎ ${t('modal.buttons.edit')}`, onAction: () => setEditMode(true) }
      }
      secondaryActions={[
        ...(editMode ? [{ content:  t('modal.buttons.cancel'), onAction: () => setEditMode(false) }] : []),
        { content: t('modal.buttons.close'), onAction: onClose }
      ]}
    >

      {/*  編集モード */}
      <Modal.Section>
        {editMode ? (
          <BlockStack gap="400">
            {/* ステータス */}
            <Select
              label={t('modal.fields.status')}
              value={formData.status || ""}
              options={STATUS_OPTIONS}
              onChange={v => setFormData(prev => ({ ...prev, status: v }))}
              disabled={formData.status === "synced"}
            />
            {/* 輸送手段 */}
            <TextField
              label={t('modal.fields.transportType')}
              value={formData.transport_type || ""}
              onChange={v => setFormData(prev => ({ ...prev, transport_type: v }))}
            />
            {/* ETD/ETA */}
            <TextField
              label={t('modal.fields.etd')}
              type="date"
              value={formData.etd || ""}
              onChange={v => setFormData(prev => ({ ...prev, etd: v }))}
            />
            <TextField
              label={t('modal.fields.eta')}
              type="date"
              value={formData.eta || ""}
              onChange={v => setFormData(prev => ({ ...prev, eta: v }))}
            />
            {/* 遅延 */}
            <Select
              label={t('modal.fields.delayed')}
              value={String(formData.delayed ?? false)}
              options={[
                { label: t('modal.options.no'), value: "false" },
                { label: t('modal.options.yes'), value: "true" }
              ]}
              onChange={v => setFormData(prev => ({ ...prev, delayed: v === "true" }))}
            />
            {/* 通関日・倉庫着日 */}
            <TextField
              label={t('modal.fields.clearanceDate')}
              type="date"
              value={formData.clearance_date || ""}
              onChange={v => setFormData(prev => ({ ...prev, clearance_date: v }))}
            />
            <TextField
              label={t('modal.fields.arrivalDate')}
              type="date"
              value={formData.arrival_date || ""}
              onChange={v => setFormData(prev => ({ ...prev, arrival_date: v }))}
            />
            {/* 仕入れ先 */}
            <TextField
              label={t('modal.fields.supplier')}
              value={formData.supplier_name || ""}
              onChange={v => setFormData(prev => ({ ...prev, supplier_name: v }))}
            />
            {/* メモ */}
            <TextField
              label={t('modal.fields.memo')}
              multiline={3}
              value={formData.memo || ""}
              onChange={v => setFormData(prev => ({ ...prev, memo: v }))}
            />
            {/* アーカイブ */}
            <Checkbox
              label={t('modal.fields.archive')}
              checked={!!formData.is_archived}
              onChange={v => setFormData(prev => ({ ...prev, is_archived: v }))}
            />
            {/* 積載商品リスト */}
            <Text as="h4" variant="headingSm">{t('modal.sections.itemList')}</Text>
            {console.log('🔍 Modal: Rendering items:', formData.items)}
            {(formData.items || []).map((item, idx) => (
              <InlineStack key={idx} gap="200" align="center">
                <TextField
                  label={t('modal.fields.itemName')}
                  value={item.name || ""}
                  onChange={v => {
                    const items = [...formData.items];
                    items[idx].name = v;
                    setFormData(prev => ({ ...prev, items }));
                  }}
                />
                <TextField
                  label={t('modal.fields.quantity')}
                  type="number"
                  value={String(item.quantity || "")}
                  onChange={v => {
                    const numValue = Number(v);
                    const items = [...formData.items];
                    // 正の整数のみ許可（1以上）
                    if (numValue >= 1) {
                      items[idx].quantity = numValue;
                    } else {
                      items[idx].quantity = 1; // 最小値1に設定
                    }
                    setFormData(prev => ({ ...prev, items }));
                  }}
                  min={1}
                  step={1}
                />
                <ShopifyVariantSelector
                  value={item.variant_id || ""}
                  products={shopifyProducts}
                  loading={shopifyProductsLoading}
                  error={shopifyProductsError}
                  onChange={(v, { product, variant }) => {
                    const items = [...formData.items];
                    items[idx].variant_id = v;
                    // 必要に応じて商品名やSKUもitemにセット可能
                    setFormData(prev => ({ ...prev, items }));
                  }}
                />
                <Button
                  size="slim"
                  destructive
                  onClick={() => {
                    const items = [...formData.items];
                    items.splice(idx, 1);
                    setFormData(prev => ({ ...prev, items }));
                  }}
                >
                  {t('modal.buttons.delete')}
                </Button>
              </InlineStack>
            ))}
            <Button
              size="slim"
              onClick={() => {
                console.log('🔍 Modal: Adding new item');
                setFormData(prev => ({
                  ...prev,
                  items: [...(prev.items || []), { name: "", quantity: 1 }]
                }));
              }}
            >
              ＋{t('modal.buttons.addItem')}
            </Button>
            {/* ファイルアップロード */}
            <Text as="h4" variant="headingSm">{t('modal.sections.relatedFiles')}</Text>
            {FILE_TYPES.map(({ key, label }) => (
              <BlockStack key={key} gap="100">
                <Text>{label}:</Text>
                <input type="file" onChange={e => handleFileUpload(e, key)} />
                {formData[`${key}_url`] && (
                  <InlineStack gap="100" align="center">
                    <Button 
                      onClick={() => handleFileView(formData[`${key}_url`], label)}
                      disabled={!signedUrlCache[formData[`${key}_url`]] && !formData[`${key}_url`].includes('token=')}
                    >
                      📄 {t('modal.buttons.viewFileType', { fileType: label })}
                      {(signedUrlCache[formData[`${key}_url`]] || formData[`${key}_url`].includes('token=')) ? ' 🔓' : ' 🔒'}
                    </Button>
                    <Button size="slim" destructive onClick={() => handleFileDelete(key)}>
                      {t('modal.buttons.delete')}
                    </Button>
                    {!signedUrlCache[formData[`${key}_url`]] && !formData[`${key}_url`].includes('token=') && (
                      <Text variant="bodySm" tone="subdued">
                        {t('modal.labels.loadingFile')}
                      </Text>
                    )}
                  </InlineStack>
                )}
              </BlockStack>
            ))}
            {/* === 削除ボタンをここに追加 === */}
            <Button
              destructive
              loading={deleting}
              onClick={handleDelete}
              style={{ marginTop: 24 }}
            >
              {t('modal.buttons.deleteShipment')}
            </Button>
            {/* ========================== */}
          </BlockStack>
        ) : (
          <BlockStack gap="300">
          <Text><b>{t('modal.fields.status')}:</b> {t('modal.status.' + statusKey)}</Text>
          {/* --- Shopify同期ボタン表示ロジック --- */}
          {shipment.status === "warehouseArrival" && (
            <BlockStack gap="200">
              <Banner status="info" title={t('modal.syncNotice.title')}>
                <p>{t('modal.syncNotice.description')}</p>
                <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>
                  <li>{t('modal.syncNotice.checklist.trackQuantity')}</li>
                  <li>{t('modal.syncNotice.checklist.requiresShipping')}</li>
                  <li>{t('modal.syncNotice.checklist.variantId')}</li>
                </ul>
                <p>{t('modal.syncNotice.warning')}</p>
                <p style={{color: 'red', fontWeight: 'bold'}}>{t('modal.syncNotice.important')}</p>
              </Banner>
              <Button
                primary
                loading={syncing}
                onClick={handleSyncShopify}
                disabled={syncing}
                style={{ marginTop: 12 }}
              >
                {t('modal.buttons.syncShopify')}
              </Button>
            </BlockStack>
          )}
            {/* --- 同期済みバナー --- */}
            {shipment.status === "synced" && (
              <Banner status="success" title={t('modal.messages.alreadySynced')}>
                {t('modal.messages.alreadySyncedDetail')}
              </Banner>
            )}
            <Text><b>{t('modal.fields.transportType')}:</b> {shipment.transport_type}</Text>
            <Text><b>{t('modal.fields.etd')}:</b> {shipment.etd}</Text>
            <Text><b>{t('modal.fields.eta')}:</b> {shipment.eta}</Text>
            <Text><b>{t('modal.fields.delayed')}:</b> {shipment.delayed ? t('modal.options.yes') : t('modal.options.no')}</Text>
            <Text><b>{t('modal.fields.clearanceDate')}:</b> {shipment.clearance_date || t('modal.labels.tbd')}</Text>
            <Text><b>{t('modal.fields.arrivalDate')}:</b> {shipment.arrival_date || t('modal.labels.tbd')}</Text>
            <Text><b>{t('modal.fields.supplier')}:</b> {shipment.supplier_name}</Text>
            <Text><b>{t('modal.fields.memo')}:</b> {shipment.memo || t('modal.labels.none')}</Text>
            <Text><b>{t('modal.fields.archive')}:</b> {shipment.is_archived ? "✅" : "❌"}</Text>
            <Text as="h4" variant="headingSm">{t('modal.sections.itemList')}</Text>
          <ul>
            {(shipment.items || []).map((item, i) => (
              <li key={i}>{item.name}：{item.quantity}{t('modal.labels.pieces')}</li>
            ))}
          </ul>
          <Text as="h4" variant="headingSm">{t('modal.sections.relatedFiles')}</Text>
          <BlockStack gap="100">
          {shipment.invoice_url && (
                <Button 
                  onClick={() => handleFileView(shipment.invoice_url, t('modal.fileTypes.invoice'))}
                >
                  {t('modal.buttons.viewFileType', { fileType: t('modal.fileTypes.invoice') })}
                </Button>
              )}
              {shipment.pl_url && (
                <Button 
                  onClick={() => handleFileView(shipment.pl_url, t('modal.fileTypes.pl'))}
                >
                  {t('modal.buttons.viewFileType', { fileType: t('modal.fileTypes.pl') })}
                </Button>
              )}
              {shipment.si_url && (
                <Button 
                  onClick={() => handleFileView(shipment.si_url, t('modal.fileTypes.si'))}
                >
                  {t('modal.buttons.viewFileType', { fileType: t('modal.fileTypes.si') })}
                </Button>
              )}
              {shipment.other_url && (
                <Button 
                  onClick={() => handleFileView(shipment.other_url, t('modal.fileTypes.other'))}
                >
                  {t('modal.buttons.viewFileType', { fileType: t('modal.fileTypes.other') })}
                </Button>
              )}
          </BlockStack>
        </BlockStack>
      )}
        </Modal.Section>
      </Modal>
  );
};


export default CustomModal;
