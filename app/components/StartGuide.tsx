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
                  輸入商品をかんたん入荷管理！
                </Text>
                <Badge tone="info">海外から届く商品が、いつ倉庫に届いて、いつ在庫になるのか？
                その流れを“見える化”して、自動でShopifyに反映します。</Badge>
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
                📦 自動化で入荷チェックを効率化！<br />
                このアプリなら、海外出荷からShopify在庫反映までをまるごと自動管理。<br />
                書類をアップロードするだけで、在庫反映までの流れがスムーズになります。              </Text>
              <Divider />

              {/* Step 1 */}
              <BlockStack gap="300">
                <InlineStack gap="300" align="start">
                  <Box>
                    <Text as="span" variant="headingMd" tone="base">1.</Text>
                  </Box>
               
                  <BlockStack gap="200">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      書類アップロード
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                    配送書類をアップロードするだけ<br />
                    納品書やインボイスの画像をアップすると、自動で内容を読み取って入荷情報を作成。<br />
                    面倒な手入力は不要です。<br />
                    🔍 対応書類例：パッキングリスト・インボイス・納品書など                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium" url="#ocr-section">
                        アップロードセクションへ
                      </Button>
                      <div style={{ width: 8, display: 'inline-block' }} />
                      <Link url="https://www.notion.so/track-to-inventory-211c3eba44cb803dbc79f9a485bc8342?source=copy_link#211c3eba44cb805ba274e891bd9d2c59" target="_blank">
                        チュートリアルを見る
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
                      配送状況を一覧でチェック
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      どこから来てる？ 何が届く？ 一目でわかる<br />
                      アップロードされた情報は、配送リストに一覧表示されます。<br />
                      納品予定日・現在のステータス・到着状況などをまとめてチェック。<br />

                      ✨ 商品名やSKU、入荷予定日もここで確認できます。                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium" url="#detail-section">
                        配送リストを見る
                      </Button>
                      <div style={{ width: 8, display: 'inline-block' }} />
                      <Link url="https://www.notion.so/track-to-inventory-211c3eba44cb803dbc79f9a485bc8342?source=copy_link#211c3eba44cb80569cbde4b68b11514b" target="_blank">
                        チュートリアルを見る
                      </Link>
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
                      詳細を確認＆編集
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                    タップで詳細を確認・必要があれば修正も<br />
                    配送カード（各商品）をタップすれば、詳細情報を確認・編集できます。<br />
                    「到着済」にしたり、「数量修正」もカンタン。                    </Text>
                    <Box paddingBlockStart="100">
                      <Button variant="primary" size="medium"  url="#card-edit">
                        エディターを試す(該当カードをクリック)
                      </Button>
                      <div style={{ width: 8, display: 'inline-block' }} />
                      <Link url="https://www.notion.so/track-to-inventory-211c3eba44cb803dbc79f9a485bc8342?source=copy_link#211c3eba44cb80ddab5dfa6fecc2e32c" target="_blank">
                        チュートリアルを見る
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