// my-next-app/components/Modal.jsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Modal,
  Button,
  TextField,
  Select,
  Checkbox,
  InlineStack,
  BlockStack,
  Text
} from '@shopify/polaris';

const CustomModal = ({ shipment, onClose }) => {
  const { t } = useTranslation('common');
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState(shipment);

const FILE_TYPES = [
  { label: t('modal.fileTypes.invoice'), key: 'invoice' },
  { label: t('modal.fileTypes.pl'), key: 'pl' },
  { label: t('modal.fileTypes.si'), key: 'si' },
  { label: t('modal.fileTypes.other'), key: 'other' },
];

  // ステータスオプションを翻訳可能にする
  const STATUS_OPTIONS = [
    { label: t('modal.status.siIssued'), value: "SI発行済" },
    { label: t('modal.status.scheduleConfirmed'), value: "船積スケジュール確定" },
    { label: t('modal.status.shipping'), value: "船積中" },
    { label: t('modal.status.customsClearance'), value: "輸入通関中" },
    { label: t('modal.status.warehouseArrival'), value: "倉庫着" }
  ];


  useEffect(() => {
    if (shipment) setFormData(shipment);
  }, [shipment]);

  if (!shipment || !formData) return null;  // 安全確認

  const handleSave = async () => {
    const res = await fetch('/api/updateShipment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipment: formData }),
    });
    const json = await res.json();
    if (json.error) {
      alert(t('modal.messages.saveFailed'));
      console.error(json.error);
    } else {
      alert(t('modal.messages.saveSuccess'));
      setEditMode(false);
    }
  };

   // ファイルアップロードAPI呼び出し
   const handleFileUpload = async (e, type) => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('si_number', formData.si_number);
    form.append('type', type);

    const res = await fetch('/api/uploadShipmentFile', {
      method: 'POST',
      body: form,
    });
    const json = await res.json();
    if (json.error) {
      alert(`${type.toUpperCase()}  ${t('modal.messages.uploadFailed')}: ${json.error}`);
      return;
    }
    setFormData((prev) => ({
      ...prev,
      [`${type}_url`]: json.publicUrl,
    }));
    alert(`${type.toUpperCase()}${t('modal.messages.uploadSuccess')}`);
  };

  // ファイル削除API呼び出し
  const handleFileDelete = async (type) => {
    const url = formData[`${type}_url`];
    if (!url) return;
    if (!window.confirm(t('modal.messages.deleteConfirm'))) return;

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
    alert(t('modal.messages.deleteSuccess'));
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
                    <Button url={formData[`${key}_url`]} target="_blank" external>
                      📄 {t('modal.buttons.viewFile', { fileType: label })}
                    </Button>
                    <Button size="slim" destructive onClick={() => handleFileDelete(key)}>
                      {t('modal.buttons.delete')}
                    </Button>
                  </InlineStack>
                )}
              </BlockStack>
            ))}
          </BlockStack>
        ) : (
          <BlockStack gap="300">
          <Text><b>{t('modal.fields.status')}:</b> {shipment.status}</Text>
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
                <Button url={shipment.invoice_url} target="_blank" external>
                  {t('modal.buttons.viewFileType', { fileType: t('modal.fileTypes.invoice') })}
                </Button>
              )}
              {shipment.pl_url && (
                <Button url={shipment.pl_url} target="_blank" external>
                  {t('modal.buttons.viewFileType', { fileType: t('modal.fileTypes.pl') })}
                </Button>
              )}
              {shipment.si_url && (
                <Button url={shipment.si_url} target="_blank" external>
                  {t('modal.buttons.viewFileType', { fileType: t('modal.fileTypes.si') })}
                </Button>
              )}
              {shipment.other_url && (
                <Button url={shipment.other_url} target="_blank" external>
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
