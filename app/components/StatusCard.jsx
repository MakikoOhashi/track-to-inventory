// my-next-app/components/StatusCard.jsx

import React from 'react';
//import { useTranslation } from 'next-i18next';
import { Card, Text } from '@shopify/polaris';

function StatusCard({ si_number, status, eta, onSelectShipment }) {
  //const { t } = useTranslation('common');  
  const t = (key) => key; //ダミー関数
  
  return (
    <Card sectioned>
       <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Text 
          variant="headingMd" 
          as="h3"
          color="interactive"
          textDecorationLine="underline"
          onClick={onSelectShipment}
          style={{ cursor: 'pointer' }}
        >
          {t('statusCard.siLabel')} {si_number}
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
    </Card>
    );
  }
  
  export default StatusCard;
  