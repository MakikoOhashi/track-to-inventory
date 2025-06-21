// app/components/Modal.jsx
import React, { useState, useEffect } from 'react';
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

const CustomModal = ({ shipment, onClose, onUpdated }) => {
  const { t, i18n } = useTranslation();
  
  // 安全な翻訳関数
  const safeTranslate = (key, fallback) => {
    try {
      return t(key) || fallback;
    } catch (error) {
      console.warn(`Translation error for key: ${key}`, error);
      return fallback;
    }
  };
  
  // FILE_TYPESの定義を関数内に移動
  const FILE_TYPES = [
    { label: safeTranslate('modal.fileTypes.invoice', 'Invoice'), key: 'invoice' },
    { label: safeTranslate('modal.fileTypes.pl', 'Packing List'), key: 'pl' },
    { label: safeTranslate('modal.fileTypes.si', 'Shipping Instruction'), key: 'si' },
    { label: safeTranslate('modal.fileTypes.other', 'Other'), key: 'other' },
  ];
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState(shipment);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ステータスオプションを英語キーで統一
  const STATUS_OPTIONS = [
    { label: safeTranslate('modal.status.siIssued', 'SI Issued'), value: "siIssued" },
    { label: safeTranslate('modal.status.scheduleConfirmed', 'Schedule Confirmed'), value: "scheduleConfirmed" },
    { label: safeTranslate('modal.status.shipping', 'Shipping'), value: "shipping" },
    { label: safeTranslate('modal.status.customsClearance', 'Customs Clearance'), value: "customsClearance" },
    { label: safeTranslate('modal.status.warehouseArrival', 'Warehouse Arrival'), value: "warehouseArrival" },
    { label: safeTranslate('modal.status.synced', 'Synced'), value: "synced" },
  ];

  useEffect(() => {
    if (shipment) setFormData(shipment);
  }, [shipment]);

  if (!shipment || !formData) return null;  // 安全確認

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
        body: JSON.stringify({ items: itemsWithVariantId })
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
          shipment: { ...formData, status: "synced" }
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

  const handleSave = async () => {
    try {
      console.log('=== SAVE OPERATION START ===');
      console.log('Current formData:', JSON.stringify(formData, null, 2));
      
      // ファイルURLフィールドの確認
      const fileFields = ['invoice_url', 'pl_url', 'si_url', 'other_url'];
      const fileUrls = {};
      fileFields.forEach(field => {
        if (formData[field]) {
          fileUrls[field] = formData[field];
        }
      });
      console.log('File URLs in formData:', fileUrls);
      
      // 必須フィールドのチェック
      if (!formData.si_number) {
        alert('SI番号は必須です');
        return;
      }
      
      console.log('Sending data to updateShipment API...');
      const res = await fetch('/api/updateShipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipment: formData }),
      });
      
      console.log('Response status:', res.status);
      console.log('Response headers:', Object.fromEntries(res.headers.entries()));
      
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
      console.log('=== SAVE OPERATION END ===');
    } catch (error) {
      console.error('Save error:', error);
      alert(`保存に失敗しました: ${error.message}`);
    }
  };

   // ファイルアップロードAPI呼び出し
   const handleFileUpload = async (e, type) => {
    const file = e.target.files[0];
    if (!file) return;

    console.log('Uploading file:', { type, fileName: file.name, fileSize: file.size }); // Debug log

    // ここから50MB制限追加 -----
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB（Supabaseの設定に合わせる）
    if (file.size > MAX_SIZE) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
      alert(`${t('modal.messages.fileTooLarge')}（現在のサイズ: ${fileSizeMB}MB）`);
      return;
    }
    // ここまで追加 -----
    
    const form = new FormData();
    form.append('file', file);
    form.append('si_number', formData.si_number);
    form.append('type', type);

    try {
      const res = await fetch('/api/uploadShipmentFile', {
        method: 'POST',
        body: form,
      });
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error('Upload failed with status:', res.status, 'Response:', errorText);
        throw new Error(`HTTP ${res.status}: ${errorText}`);
      }
      
      const json = await res.json();
      if (json.error) {
        console.error('Upload failed with error:', json.error);
        alert(`${type.toUpperCase()}  ${t('modal.messages.uploadFailed')}: ${json.error}`);
        return;
      }
      
      console.log('Upload successful:', json); // Debug log
      console.log('Setting formData with new file path:', { field: `${type}_url`, filePath: json.filePath });
      setFormData((prev) => {
        const newData = {
          ...prev,
          [`${type}_url`]: json.filePath, // ファイルパスを保存
        };
        console.log('Updated formData:', newData);
        return newData;
      });
      
      // ファイルアップロード成功後に即座にデータベースに保存
      try {
        console.log('Auto-saving after file upload...');
        const updatedFormData = {
          ...formData,
          [`${type}_url`]: json.filePath, // ファイルパスを保存
        };
        
        const saveRes = await fetch('/api/updateShipment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shipment: updatedFormData }),
        });
        
        if (!saveRes.ok) {
          const errorText = await saveRes.text();
          console.error('Auto-save failed:', saveRes.status, errorText);
          alert(`${type.toUpperCase()}アップロード成功しましたが、データベースへの保存に失敗しました: ${errorText}`);
          return;
        }
        
        const saveJson = await saveRes.json();
        if (saveJson.error) {
          console.error('Auto-save failed with error:', saveJson.error);
          alert(`${type.toUpperCase()}アップロード成功しましたが、データベースへの保存に失敗しました: ${saveJson.error}`);
          return;
        }
        
        console.log('Auto-save successful');
        if (onUpdated) onUpdated(); // 親コンポーネントに更新を通知
      } catch (saveError) {
        console.error('Auto-save error:', saveError);
        alert(`${type.toUpperCase()}アップロード成功しましたが、データベースへの保存に失敗しました: ${saveError.message}`);
        return;
      }
      
      alert(`${type.toUpperCase()}${t('modal.messages.uploadSuccess')}`);
    } catch (error) {
      console.error('Upload error:', error);
      alert(`${type.toUpperCase()}  ${t('modal.messages.uploadFailed')}: ${error.message}`);
    }
  };

  // ファイル削除API呼び出し
  const handleFileDelete = async (type) => {
    const url = formData[`${type}_url`];
    if (!url) return;
    // クライアントのみでconfirmを使う
    if (typeof window !== "undefined" && !window.confirm(t('modal.messages.deleteConfirm'))) {
      return;
    }
    
    const res = await fetch('/api/deleteShipmentFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        si_number: formData.si_number,
        type,
        url,
      }),
    });
    const json = await res.json();
    if (json.error) {
      alert(`${t('modal.messages.deleteFailed')}: ${json.error}`);
      return;
    }
    setFormData((prev) => ({
      ...prev,
      [`${type}_url`]: undefined,
    }));
    
    // ファイル削除成功後に即座にデータベースに保存
    try {
      console.log('Auto-saving after file deletion...');
      const updatedFormData = {
        ...formData,
        [`${type}_url`]: undefined,
      };
      
      const saveRes = await fetch('/api/updateShipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipment: updatedFormData }),
      });
      
      if (!saveRes.ok) {
        const errorText = await saveRes.text();
        console.error('Auto-save after deletion failed:', saveRes.status, errorText);
        alert(`ファイル削除成功しましたが、データベースへの保存に失敗しました: ${errorText}`);
        return;
      }
      
      const saveJson = await saveRes.json();
      if (saveJson.error) {
        console.error('Auto-save after deletion failed with error:', saveJson.error);
        alert(`ファイル削除成功しましたが、データベースへの保存に失敗しました: ${saveJson.error}`);
        return;
      }
      
      console.log('Auto-save after deletion successful');
      if (onUpdated) onUpdated(); // 親コンポーネントに更新を通知
    } catch (saveError) {
      console.error('Auto-save after deletion error:', saveError);
      alert(`ファイル削除成功しましたが、データベースへの保存に失敗しました: ${saveError.message}`);
      return;
    }
    
    alert(t('modal.messages.deleteSuccess'));
  };

  // 既存データが日本語の場合は変換
  const statusKey = statusJaToKey[shipment.status] || shipment.status;

  // handleDeleteを復元
  const handleDelete = async () => {
    if (!window.confirm(t('modal.messages.deleteShipmentConfirm'))) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/delete-shipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_id: shipment.shop_id,
          si_number: shipment.si_number,
          plan: shipment.plan, // 必要に応じて
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(t('modal.messages.deleteGeneralFailed'));
      alert(t('modal.messages.deleteSuccess'));
      if (onUpdated) onUpdated();
      onClose();
    } catch (e) {
      alert(e.message || t('modal.messages.deleteGeneralFailed'));
    } finally {
      setDeleting(false);
    }
  };

  // ファイル表示用のsigned URL取得関数
  const getSignedUrl = async (filePath) => {
    try {
      console.log('getSignedUrl called with:', filePath);
      
      // 署名付きURLの場合は、ファイルパスを抽出
      let actualFilePath = filePath;
      
      // 署名付きURLの場合（token=で始まる場合）、パスを抽出
      if (filePath && filePath.includes('token=')) {
        try {
          const url = new URL(filePath);
          const pathMatch = url.pathname.match(/\/storage\/v1\/object\/sign\/shipment-files\/(.+)/);
          if (pathMatch) {
            actualFilePath = pathMatch[1];
            console.log('Extracted file path from signed URL:', actualFilePath);
          }
        } catch (urlError) {
          console.error('URL parsing error:', urlError);
          // URL解析に失敗した場合は、元のパスを使用
        }
      } else {
        console.log('Using original file path (not a signed URL):', actualFilePath);
      }
      
      // ファイルパスが空の場合はエラー
      if (!actualFilePath) {
        throw new Error('Invalid file path');
      }

      console.log('Requesting signed URL for file path:', actualFilePath);

      const res = await fetch('/api/get-file-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: actualFilePath })
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`Failed to get signed URL: ${errorData.error || res.statusText}`);
      }
      
      const json = await res.json();
      console.log('Successfully received signed URL');
      return json.signedUrl;
    } catch (error) {
      console.error('Error getting signed URL:', error);
      return null;
    }
  };

  // ファイル表示ボタンのクリックハンドラー
  const handleFileView = async (filePath, fileType) => {
    const signedUrl = await getSignedUrl(filePath);
    if (signedUrl) {
      window.open(signedUrl, '_blank');
    } else {
      alert(`${fileType}ファイルの表示に失敗しました`);
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
                    const items = [...formData.items];
                    items[idx].quantity = Number(v);
                    setFormData(prev => ({ ...prev, items }));
                  }}
                  min={1}
                />
                <ShopifyVariantSelector
                  value={item.variant_id || ""}
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
              onClick={() =>
                setFormData(prev => ({
                  ...prev,
                  items: [...(prev.items || []), { name: "", quantity: 1 }]
                }))
              }
            >
              ＋{t('modal.buttons.addItem')}
            </Button>
            {/* ファイルアップロード */}
            <Text as="h4" variant="headingSm">{t('modal.sections.relatedFiles')}</Text>
            {FILE_TYPES.map(({ label, key }) => (
              <BlockStack key={key} gap="100">
                <Text>{label}:</Text>
                <input type="file" onChange={e => handleFileUpload(e, key)} />
                {formData[`${key}_url`] && (
                  <InlineStack gap="100">
                    <Button 
                      onClick={() => handleFileView(formData[`${key}_url`], label)}
                    >
                      📄 {t('modal.buttons.viewFile', { fileType: label })}
                    </Button>
                    <Button size="slim" destructive onClick={() => handleFileDelete(key)}>
                      {t('modal.buttons.delete')}
                    </Button>
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
