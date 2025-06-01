//my-next-app/components/StatusTable.jsx

import React, { useState } from 'react';
//import { useTranslation } from 'next-i18next';
import { Checkbox, DataTable, Text } from '@shopify/polaris';

function StatusTable({ shipments, onSelectShipment }) {
  //const { t } = useTranslation('common');
  const t = (key) => key; //ダミー関数
  const [showArchived, setShowArchived] = useState(false);

  const filteredShipments = showArchived
    ? shipments
    : shipments.filter((s) => !s.is_archived);

    const rows = filteredShipments.map((s) => [
      <Text 
        as="span" 
        color="interactive" 
        textDecorationLine="underline"
        onClick={() => onSelectShipment(s)}
        style={{ cursor: 'pointer' }}
      >
        {s.si_number}
      </Text>,
      s.status,
      s.eta,
    ]);
  
    const columnContentTypes = ['text', 'text', 'text'];
  
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
        hasZebraStriping
      />
      
    </div>
  );
}

export default StatusTable;
