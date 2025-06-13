import React, { useState } from 'react';
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Icon
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
              <Text as="span" variant="bodyMd">💡</Text>
              <Text as="h3" variant="headingLg">
                在庫管理のヒント
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
                効率的な在庫管理のために、以下の機能をご活用ください。お時間のあるときにお試しいただけます。
              </Text>
              
              <BlockStack gap="300">
                {/* Tip1 */}
                <Card>
                  <Box padding="400">
                    <BlockStack gap="300">
                      <InlineStack gap="300" align="start">
                        <Icon source={UploadIcon} />
                        <BlockStack gap="200">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            配送書類をアップロード
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            配送書類の画像をアップロードすると、OCRが自動的に情報を抽出します。手動入力の手間を省けます。
                          </Text>
                          <Box paddingBlockStart="200">
                            <Button
                              variant="primary"
                              size="medium"
                              url="/upload"
                              external={false}
                            >
                              アップロードページへ
                            </Button>
                          </Box>
                        </BlockStack>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                </Card>

                {/* Tip2 */}
                <Card>
                  <Box padding="400">
                    <BlockStack gap="300">
                      <InlineStack gap="300" align="start">
                        <Icon source={ViewIcon} />
                        <BlockStack gap="200">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            配送リストで一覧確認
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            OCR処理が完了した配送情報は、配送リストで一覧表示されます。ステータスも一目で確認できます。
                          </Text>
                          <Box paddingBlockStart="200">
                            <Button
                              variant="primary"
                              size="medium"
                              url="/shipments"
                              external={false}
                            >
                              配送リストを見る
                            </Button>
                          </Box>
                        </BlockStack>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                </Card>

                {/* Tip3 */}
                <Card>
                  <Box padding="400">
                    <BlockStack gap="300">
                      <InlineStack gap="300" align="start">
                        <Icon source={EditIcon} />
                        <BlockStack gap="200">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            詳細情報の確認・編集
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            配送カードをクリックすると詳細情報が表示されます。必要に応じて情報を編集・修正できます。
                          </Text>
                          <Box paddingBlockStart="200">
                            <Button
                              variant="primary"
                              size="medium"
                              url="/edit"
                              external={false}
                            >
                              エディターを試す
                            </Button>
                          </Box>
                        </BlockStack>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                </Card>
              </BlockStack>

              {/* 追加情報 */}
              <Card>
                <Box padding="300">
                  <InlineStack gap="200" align="center">
                    <Text as="span" variant="bodyMd">✨</Text>
                    <Text as="span" variant="bodyMd" fontWeight="medium">
                      これらの機能は必要に応じてご利用ください。いつでもここに戻ってこれます。
                    </Text>
                  </InlineStack>
                </Box>
              </Card>

              {/* フッター */}
              <Box paddingBlockStart="400">
                <InlineStack align="end">
                  <Button 
                    onClick={onDismiss} 
                    variant="tertiary"
                    size="medium"
                  >
                    ヒントを閉じる
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