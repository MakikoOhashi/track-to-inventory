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
  Divider
} from '@shopify/polaris';
import { XIcon, UploadIcon, ViewIcon, EditIcon, PackageIcon } from '@shopify/polaris-icons';

const ImportCargoGuide = ({ onDismiss }: { onDismiss: () => void }) => {
  const [isExpanded, setIsExpanded] = useState(true);

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
                  輸入貨物の入荷管理を始めましょう
                </Text>
                <Badge tone="info">自動化で効率アップ</Badge>
              </BlockStack>
            </InlineStack>
            <InlineStack gap="200">
              <Button
                onClick={toggleExpanded}
                variant="plain"
                size="slim"
              >
                {isExpanded ? '詳細を閉じる' : '詳細を表示'}
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
                こちらのアプリを使えば現地を出発してShopifyの在庫になるまで、しっかりトラッキング管理できます。倉庫に到着すれば、自動でShopify在庫に追加。SIやINVをOCRで読み取って自動でデータ追加して簡単に始められます。
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
                      配送書類をアップロード
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      配送書類の画像をアップロードすると、OCRが自動的に情報を抽出します。手動入力の手間を省けます。
                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium">
                        アップロードページへ
                      </Button>
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
                      配送リストで一覧確認
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      OCR処理が完了した配送情報は、配送リストで一覧表示されます。ステータスも一目で確認できます。
                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium">
                        配送リストを見る
                      </Button>
                    </Box>
                  </BlockStack>
                </InlineStack>
              </BlockStack>

              <Divider />

              {/* Step 3 */}
              <BlockStack gap="300">
                <InlineStack gap="300" align="start">
                  <Box>
                    <Text as="span" variant="headingMd" tone="base">3.</Text>
                  </Box>
                
                  <BlockStack gap="200">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      詳細情報の確認・編集
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      配送カードをクリックすると詳細情報が表示されます。必要に応じて情報を編集・修正できます。
                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium">
                        エディターを試す
                      </Button>
                    </Box>
                  </BlockStack>
                </InlineStack>
              </BlockStack>

              <Divider />

              {/* フッター */}
              <InlineStack align="center" gap="200">
                <Text as="span" variant="bodyMd">✨</Text>
                <Text as="span" variant="bodyMd" tone="subdued">
                  これらの機能は必要に応じてご利用ください。いつでもここに戻ってこれます。
                </Text>
              </InlineStack>

              <Box paddingBlockStart="300">
                <InlineStack align="end">
                  <Button 
                    onClick={onDismiss} 
                    variant="tertiary"
                    size="medium"
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

export default ImportCargoGuide;