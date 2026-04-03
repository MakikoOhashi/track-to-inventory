// app/components/StatusCard.tsx

import React from 'react';
import { useTranslation } from 'react-i18next'; 
import { Card, Text,BlockStack } from '@shopify/polaris';
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

const StatusCard: React.FC<Shipment & { onSelectShipment: () => void }> = ({
  si_number,
  shop_id,
  status,
  etd,
  eta,
  delayed,
  transport_type,
  memo,
  items,
  clearance_date,
  supplier_name,
  arrival_date,
  is_archived,
  invoice_url,
  pl_url,
  other_url,
  si_url,
  onSelectShipment
}) => {

  const { t } = useTranslation('common');
  const statusKey = statusToKey[status ?? ""] || "notSet";
  
  return (
    <Card>
      <BlockStack>
       <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Text 
          variant="headingMd" 
          as="h3"
         >
          <span
          onClick={onSelectShipment}
          style={{ cursor: 'pointer', textDecoration: 'underline' }}
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') onSelectShipment(); }}
          role="button"
          >
          {t('statusCard.siLabel')} {si_number}
          </span>
        </Text>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <Text as="p">
            <Text variant="bodyMd" fontWeight="semibold" as="span">
              {t('statusCard.siNumber')}
            </Text>
            #{si_number}
          </Text>
          
          <Text as="p">
            <Text variant="bodyMd" fontWeight="semibold" as="span">
              {t('statusCard.status')}
            </Text>
            {t('modal.status.' + statusKey)}
          </Text>
          
          <Text as="p">
            <Text variant="bodyMd" fontWeight="semibold" as="span">
              {t('statusCard.eta')}
            </Text>
            {eta}
          </Text>
        </div>
      </div>
      </BlockStack>
    </Card>
    );
  }
  
  export default StatusCard;
  