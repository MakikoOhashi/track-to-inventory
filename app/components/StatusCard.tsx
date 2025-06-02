// app/components/StatusCard.tsx

import React from 'react';
import { useTranslation } from 'react-i18next'; 
import { Card, Text,BlockStack } from '@shopify/polaris';
import type { Shipment } from "../../types/Shipment";

type StatusCardProps = Shipment & {
  onSelectShipment: () => void;
};


const StatusCard: React.FC<StatusCardProps> = ({
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
            {status}
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
  