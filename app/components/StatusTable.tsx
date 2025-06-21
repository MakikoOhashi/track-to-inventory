//app/components/StatusTable.tsx

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next'; 
import { Checkbox, DataTable, Text } from '@shopify/polaris';
import type { Shipment } from "../../types/Shipment";

// ステータス日本語→英語キー変換マップ（全パターン対応）
const statusToKey: Record<string, string> = {
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
  "同期済み": "synced",
  "Synced": "synced",
  "synced": "synced",
  "未設定": "notSet",
  "Not Set": "notSet",
  "notSet": "notSet"
};

const StatusTable: React.FC<{ shipments: Shipment[]; onSelectShipment: (shipment: Shipment) => void; }> = ({ shipments, onSelectShipment }) => {
  const { t } = useTranslation('common');
  const [showArchived, setShowArchived] = useState(false);

  // 安全な翻訳関数
  const safeTranslate = (key: string, fallback: string) => {
    try {
      return t(key) || fallback;
    } catch (error) {
      console.warn(`Translation error for key: ${key}`, error);
      return fallback;
    }
  };

  const filteredShipments = showArchived
    ? shipments
    : shipments.filter((s) => !s.is_archived);

  const rows = filteredShipments.map((s) => {
    const statusKey = statusToKey[s.status ?? ""] || "notSet";
    return [
      <span
        key={`si-${s.si_number}`}
        onClick={() => onSelectShipment(s)}
        style={{ cursor: 'pointer', textDecoration: 'underline' }}
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter') onSelectShipment(s); }}
        title={safeTranslate('message.clickForDetails', 'Click for details')}
        role="button"
      >
        {s.si_number}
      </span>,
      safeTranslate('modal.status.' + statusKey, s.status || 'Not Set'),
      s.eta || 'Not set',
    ];
  });

  const columnContentTypes: ("text" | "numeric")[] = ['text', 'text', 'text'];

  const headings = [
    safeTranslate('statusTable.siNumber', 'SI Number'),
    safeTranslate('statusTable.status', 'Status'),
    safeTranslate('statusTable.eta', 'ETA'),
  ];

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <Checkbox
          label={safeTranslate('statusTable.showArchived', 'Show archived')}
          checked={showArchived}
          onChange={setShowArchived}
        />
      </div>

      <DataTable
        columnContentTypes={columnContentTypes}
        headings={headings}
        rows={rows}
      />
    </div>
  );
}

export default StatusTable;
