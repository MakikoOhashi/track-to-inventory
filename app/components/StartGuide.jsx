import React, { useState, useEffect } from 'react';
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Icon
} from '@shopify/polaris';
import { XIcon } from '@shopify/polaris-icons';

const StartGuide = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    // 初回表示判定のロジック
    // 実際の実装では localStorage または Supabase user_metadata を使用
    const hasSeenGuide = false; // localStorage.getItem('hasSeenStartGuide') === 'true';
    const isFirstTime = true; // user?.user_metadata?.first_time === true;
    
    if (!hasSeenGuide || isFirstTime) {
      setIsVisible(true);
    }
  }, []);

  const dismissGuide = () => {
    setIsVisible(false);
    // localStorage.setItem('hasSeenStartGuide', 'true');
    // または Supabase でユーザー設定を更新
  };

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  if (!isVisible) return null;

  return (
    <Card>
      <Box
        padding="400"
        background="bg-surface-brand-subdued"
        borderRadius="200"
      >
        <BlockStack gap="400">
          {/* ヘッダー */}
          <InlineStack align="space-between">
            <InlineStack gap="200" align="center">
              <Box
                background="bg-surface-brand"
                padding="200"
                borderRadius="50"
                minWidth="32px"
                minHeight="32px"
              >
                <Text as="span" variant="bodyMd" tone="text-inverse" alignment="center">
                  🚀
                </Text>
              </Box>
              <Text as="h3" variant="headingLg" tone="text-brand">
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
                onClick={dismissGuide}
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
                        borderRadius="50"
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
                        borderRadius="50"
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
                        borderRadius="50"
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
                <Box padding="300" background="bg-surface-success-subdued">
                  <InlineStack gap="200" align="center">
                    <Text as="span" variant="bodyMd">✅</Text>
                    <Text as="span" variant="bodyMd" fontWeight="medium" tone="success">
                      まずは出荷帳票の画像をアップロードしてみましょう！
                    </Text>
                  </InlineStack>
                </Box>
              </Card>

              {/* フッター */}
              <Box paddingBlockStart="400" borderBlockStart="divider">
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm" tone="subdued">
                    このガイドは一度非表示にすると、再表示されません
                  </Text>
                  <Button 
                    onClick={dismissGuide} 
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