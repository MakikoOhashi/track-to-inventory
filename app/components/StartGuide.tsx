import React, { useState, useEffect } from 'react';
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Icon,
  Link
} from '@shopify/polaris';
import { XIcon } from '@shopify/polaris-icons';

const StartGuide = ({ onDismiss }: { onDismiss: () => void }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const toggleExpanded = () => setIsExpanded(!isExpanded);

  return (
    <Card>
      <Box
        padding="400"
        borderRadius="200"
      >
        <BlockStack gap="400">
          {/* ヘッダー */}
          <InlineStack align="space-between">
            <InlineStack gap="200" align="center">
              <Box
                padding="200"
                minWidth="32px"
                minHeight="32px"
              >
                <Text as="span" variant="bodyMd" tone="text-inverse" alignment="center">
                  🚀
                </Text>
              </Box>
              <Text as="h3" variant="headingLg">
                初めてのご利用ですか？
              </Text>
            </InlineStack>
            <InlineStack gap="200">
              <Button
                onClick={toggleExpanded}
                variant="plain"
                size="slim"
                tone="critical"
              >
                {isExpanded ? '折りたたむ' : '詳細を見る'}
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
                <Text as="span" fontWeight="bold">3ステップ</Text>で在庫管理を始められます：
              </Text>
              
              <BlockStack gap="300">
                {/* ステップ1 */}
                <Card>
                  <Box padding="300">
                    <InlineStack gap="300" align="start">
                      <Box
                        background="bg-surface-brand"
                        padding="200"
                        minWidth="32px"
                        minHeight="32px"
                      >
                        <Text as="span" variant="bodyMd" tone="text-inverse" alignment="center" fontWeight="bold">
                          1
                        </Text>
                      </Box>
                      <BlockStack gap="100">
                        <InlineStack gap="200" align="center">
                          <Text as="span" variant="bodyMd">📤</Text>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            出荷帳票をアップロード
                          </Text>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          出荷帳票の画像をアップロードすると、OCRが自動で情報を読み取ります
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                </Card>

                {/* ステップ2 */}
                <Card>
                  <Box padding="300">
                    <InlineStack gap="300" align="start">
                      <Box
                        background="bg-surface-brand"
                        padding="200"
                        minWidth="32px"
                        minHeight="32px"
                      >
                        <Text as="span" variant="bodyMd" tone="text-inverse" alignment="center" fontWeight="bold">
                          2
                        </Text>
                      </Box>
                      <BlockStack gap="100">
                        <InlineStack gap="200" align="center">
                          <Text as="span" variant="bodyMd">📋</Text>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            出荷一覧で確認
                          </Text>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          OCR完了後、出荷一覧に自動で反映されます
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                </Card>

                {/* ステップ3 */}
                <Card>
                  <Box padding="300">
                    <InlineStack gap="300" align="start">
                      <Box
                        background="bg-surface-brand"
                        padding="200"
                        minWidth="32px"
                        minHeight="32px"
                      >
                        <Text as="span" variant="bodyMd" tone="text-inverse" alignment="center" fontWeight="bold">
                          3
                        </Text>
                      </Box>
                      <BlockStack gap="100">
                        <InlineStack gap="200" align="center">
                          <Text as="span" variant="bodyMd">✏️</Text>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            詳細確認・編集
                          </Text>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          出荷カードをクリックして、詳細情報の確認や編集ができます
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                </Card>
              </BlockStack>

              {/* コールトゥアクション */}
              <Card>
                <Box padding="300">
                  <InlineStack gap="200" align="center">
                    <Text as="span" variant="bodyMd">✅</Text>
                    <Text as="span" variant="bodyMd" fontWeight="medium" tone="success">
                      まずは出荷帳票の画像をアップロードしてみましょう！
                    </Text>
                  </InlineStack>
                </Box>
              </Card>

              {/* フッター */}
              <Box paddingBlockStart="400">
                <InlineStack align="space-between">
                  {/* <Text as="span" variant="bodySm" tone="subdued">
                    このガイドは一度非表示にすると、再表示されません
                  </Text> */}
                  <Button 
                    onClick={onDismiss} 
                    variant="primary"
                    size="slim"
                  >
                    ガイドを閉じる
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