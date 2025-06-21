import React, { useState } from 'react';
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Icon,
  Badge,
  Divider,
  Link
} from '@shopify/polaris';
import { XIcon, UploadIcon, ViewIcon, EditIcon, PackageIcon } from '@shopify/polaris-icons';
import { useTranslation } from 'react-i18next';

const ImportCargoGuide = ({ onDismiss }: { onDismiss: () => void }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const { t } = useTranslation('common');

  const toggleExpanded = () => setIsExpanded(!isExpanded);

  return (
    <Card>
      <Box padding="500">
        <BlockStack gap="500">
          {/* ヘッダー */}
          <InlineStack align="space-between">
            <InlineStack gap="400" align="center">
              <Icon source={PackageIcon} />
              <BlockStack gap="100">
                <Text as="h2" variant="headingXl">
                  {t('startGuide.title')}
                </Text>
                <Badge tone="info">{t('startGuide.badge')}</Badge>
              </BlockStack>
            </InlineStack>
            <InlineStack gap="200">
              <Button
                onClick={toggleExpanded}
                variant="plain"
                size="slim"
              >
                {isExpanded ? t('startGuide.closeDetail') : t('startGuide.openDetail')}
              </Button>
              <Button
                onClick={onDismiss}
                variant="plain"
                size="slim"
                icon={XIcon}
              />
            </InlineStack>
          </InlineStack>

          {/* 展開時のコンテンツ */}
          {isExpanded && (
            <BlockStack gap="400">
              {/* メイン説明 */}
              <Text as="p" variant="bodyLg">
                {t('startGuide.mainDescription1')}<br />
                {t('startGuide.mainDescription2')}<br />
                {t('startGuide.mainDescription3')}
              </Text>
              <Divider />

              {/* Step 1 */}
              <BlockStack gap="300">
                <InlineStack gap="300" align="start">
                  <Box>
                    <Text as="span" variant="headingMd" tone="base">1.</Text>
                  </Box>
               
                  <BlockStack gap="200">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {t('startGuide.step1.title')}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t('startGuide.step1.desc1')}<br />
                      {t('startGuide.step1.desc2')}<br />
                      {t('startGuide.step1.desc3')}<br />
                      {t('startGuide.step1.desc4')}
                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium" url="#ocr-section">
                        {t('startGuide.step1.button')}
                      </Button>
                      <div style={{ width: 8, display: 'inline-block' }} />
                      <Link url="https://www.notion.so/track-to-inventory-211c3eba44cb803dbc79f9a485bc8342?source=copy_link#211c3eba44cb805ba274e891bd9d2c59" target="_blank">
                        {t('startGuide.tutorial')}
                      </Link>
                    </Box>
                  </BlockStack>
                </InlineStack>
              </BlockStack>

              <Divider />

              {/* Step 2 */}
              <BlockStack gap="300">
                <InlineStack gap="300" align="start">
                  <Box>
                    <Text as="span" variant="headingMd" tone="base">2.</Text>
                  </Box>
               
                  <BlockStack gap="200">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {t('startGuide.step2.title')}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t('startGuide.step2.desc1')}<br />
                      {t('startGuide.step2.desc2')}<br />
                      {t('startGuide.step2.desc3')}<br />
                      {t('startGuide.step2.desc4')}
                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium" url="#detail-section">
                        {t('startGuide.step2.button')}
                      </Button>
                      <div style={{ width: 8, display: 'inline-block' }} />
                      <Link url="https://www.notion.so/track-to-inventory-211c3eba44cb803dbc79f9a485bc8342?source=copy_link#211c3eba44cb80569cbde4b68b11514b" target="_blank">
                        {t('startGuide.tutorial')}
                      </Link>
                    </Box>
                  </BlockStack>
                </InlineStack>
              </BlockStack>

              <Divider />ぎ

              {/* Step 3 */}
              <BlockStack gap="300">
                <InlineStack gap="300" align="start">
                  <Box>
                    <Text as="span" variant="headingMd" tone="base">3.</Text>
                  </Box>
                
                  <BlockStack gap="200">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {t('startGuide.step3.title')}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t('startGuide.step3.desc1')}<br />
                      {t('startGuide.step3.desc2')}<br />
                      {t('startGuide.step3.desc3')}
                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium"  url="#card-edit">
                        {t('startGuide.step3.button')}
                      </Button>
                      <div style={{ width: 8, display: 'inline-block' }} />
                      <Link url="https://www.notion.so/track-to-inventory-211c3eba44cb803dbc79f9a485bc8342?source=copy_link#211c3eba44cb80ddab5dfa6fecc2e32c" target="_blank">
                        {t('startGuide.tutorial')}
                      </Link>
                    </Box>
                  </BlockStack>
                </InlineStack>
              </BlockStack>

              <Divider />

              {/* フッター */}
              <InlineStack align="center" gap="200">
                <Text as="span" variant="bodyMd">✨</Text>
                <Text as="span" variant="bodyMd" tone="subdued">
                  {t('startGuide.footer')}
                </Text>
              </InlineStack>

              <Box paddingBlockStart="300">
                <InlineStack align="end">
                  <Button 
                    onClick={onDismiss} 
                    variant="tertiary"
                    size="medium"
                  >
                    {t('startGuide.closeGuide')}
                  </Button>
                </InlineStack>
              </Box>
            </BlockStack>
          )}
        </BlockStack>
      </Box>
    </Card>
  );
};

export default ImportCargoGuide;