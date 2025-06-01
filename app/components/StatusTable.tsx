//my-next-app/components/StatusTable.jsx

import React, { useState } from 'react';
//import { useTranslation } from 'next-i18next';
import { Checkbox, DataTable, Text } from '@shopify/polaris';

// Shipment型は他ファイルで定義済みならimportしてもOK
type Shipment = {
  si_number: string;
  status?: string;
  eta: string;
  is_archived?: boolean; // アーカイブフラグ有無も型に追加
};

type StatusTableProps = {
  shipments: Shipment[];
  onSelectShipment: (shipment: Shipment) => void;
};

const StatusTable: React.FC<StatusTableProps> = ({ shipments, onSelectShipment }) => {
  //const { t } = useTranslation('common');
  const t = (key: string) => key; //ダミー関数
  const [showArchived, setShowArchived] = useState(false);

  const filteredShipments = showArchived
    ? shipments
    : shipments.filter((s) => !s.is_archived);

    const rows = filteredShipments.map((s) => [
      <Text as="span">
        <span
          onClick={() => onSelectShipment(s)}
          style={{ cursor: 'pointer', textDecoration: 'underline' }}
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') onSelectShipment(s); }}
          title="詳細を表示"
        >
        {s.si_number}
        </span>
      </Text>,
      s.status,
      s.eta,
    ]);
  
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
