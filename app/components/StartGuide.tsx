import React, { useState } from 'react';
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Badge,
} from '@shopify/polaris';
import { XIcon, UploadIcon, ViewIcon, EditIcon } from '@shopify/polaris-icons';

const StartGuide = ({ onDismiss }: { onDismiss: () => void }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const toggleExpanded = () => setIsExpanded(!isExpanded);

  return (
    <Card>
      <Box padding="400">
        <BlockStack gap="400">
          {/* ヘッダー */}
          <InlineStack align="space-between">
            <InlineStack gap="300" align="center">
              <Box>
                <Text as="span" variant="bodyMd">
                  🚀
                </Text>
              </Box>
              <Text as="h3" variant="headingLg">
                Get started with inventory management
              </Text>
            </InlineStack>
            <InlineStack gap="200">
              <Button
                onClick={toggleExpanded}
                variant="plain"
                size="slim"
              >
                {isExpanded ? 'Collapse' : 'Show details'}
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
              <Text as="p" variant="bodyMd" tone="subdued">
                Set up your inventory management in <Text as="span" fontWeight="bold">3 steps</Text>:
              </Text>
              
              <BlockStack gap="300">
                {/* ステップ1 */}
                <Card>
                  <InlineStack gap="300" align="start">
                    <Badge>1</Badge>
                    <BlockStack gap="200">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Upload shipping documents
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Upload images of your shipping documents and OCR will automatically extract the information
                      </Text>
                      <Button
                        variant="plain"
                        size="slim"
                        url="/upload"
                        external={false}
                      >
                        Go to upload
                      </Button>
                    </BlockStack>
                  </InlineStack>
                </Card>

                {/* ステップ2 */}
                <Card>
                  <InlineStack gap="300" align="start">
                    <Badge>2</Badge>
                    <BlockStack gap="200">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Review in shipments list
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        After OCR processing is complete, your shipments will automatically appear in the list
                      </Text>
                      <Button
                        variant="plain"
                        size="slim"
                        url="/shipments"
                        external={false}
                      >
                        View shipments
                      </Button>
                    </BlockStack>
                  </InlineStack>
                </Card>

                {/* ステップ3 */}
                <Card>
                  <InlineStack gap="300" align="start">
                    <Badge>3</Badge>
                    <BlockStack gap="200">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Review and edit details
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Click on any shipment card to view and edit detailed information
                      </Text>
                      <Button
                        variant="plain"
                        size="slim"
                        url="/edit"
                        external={false}
                      >
                        Go to editor
                      </Button>
                    </BlockStack>
                  </InlineStack>
                </Card>
              </BlockStack>

              {/* コールトゥアクション */}
              <Card>
                <Box padding="300">
                  <InlineStack gap="200">
                    <Text as="span" variant="bodyMd">✅</Text>
                    <Text as="span" variant="bodyMd" fontWeight="medium" tone="success">
                      Start by uploading your first shipping document!
                    </Text>
                  </InlineStack>
                </Box>
              </Card>

              {/* フッター */}
              <Box paddingBlockStart="400">
                <InlineStack align="space-between">
                  <Button 
                    onClick={onDismiss} 
                    variant="primary"
                    size="slim"
                  >
                    Close guide
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

export default StartGuide;