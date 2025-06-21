//app/components/StatusTable.tsx

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next'; 
import { Checkbox, DataTable, Text } from '@shopify/polaris';
import type { Shipment } from "../../types/Shipment";

// ステータス日本語→英語キー変換マップ
const statusJaToKey = {
  "SI発行済": "siIssued",
  "船積スケジュール確定": "scheduleConfirmed",
  "船積中": "shipping",
  "輸入通関中": "customsClearance",
  "倉庫着": "warehouseArrival",
  "同期済み": "synced"
};

const StatusTable: React.FC<{ shipments: Shipment[]; onSelectShipment: (shipment: Shipment) => void; }> = ({ shipments, onSelectShipment }) => {
  const { t } = useTranslation('common');
  const [showArchived, setShowArchived] = useState(false);

  const filteredShipments = showArchived
    ? shipments
    : shipments.filter((s) => !s.is_archived);

  const rows = filteredShipments.map((s) => {
    const statusKey = s.status ? (statusJaToKey[s.status as keyof typeof statusJaToKey] || s.status) : '';
    return [
      <Text as="span">
        <span
          onClick={() => onSelectShipment(s)}
          style={{ cursor: 'pointer', textDecoration: 'underline' }}
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') onSelectShipment(s); }}
          title={t('message.clickForDetails')}
        >
        {s.si_number}
        </span>
      </Text>,
      t('modal.status.' + statusKey),
      s.eta,
    ];
  });

  const columnContentTypes: ("text" | "numeric")[] = ['text', 'text', 'text'];

  const headings = [
    t('statusTable.siNumber'),
    t('statusTable.status'),
    t('statusTable.eta'),
  ];

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <Checkbox
          label={t('statusTable.showArchived')}
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
