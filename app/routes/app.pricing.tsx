import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Page,
  Card,
  TextContainer,
  Layout,
  Text,
  InlineStack,
  BlockStack,
  Badge,
  Button,
  Divider,
  Box,
  Scrollable,
  DataTable,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Pricing() {
  // 各プランのShopify Billing用リンク（後で置き換えてください）
  const billingLinks = {
    free: "#", // 無料プランは申し込み不要
    basic: "https://your-billing-link/basic", // Shopify Billingのリンクに差し替え
    pro: "https://your-billing-link/pro",     // Shopify Billingのリンクに差し替え
  };

  // プラン情報
  const plans = [
    {
      name: "Free",
      price: "¥0",
      siCount: "2件まで",
      siDelete: "月2回まで",
      ocr: "月5回",
      storage: "各ファイル最大10MB・最大4枚（計40MB）",
      inventory: "×",
      support: "×",
      ai: "月5回まで",
      badge: <Badge tone="success">現在のプラン</Badge>,
      button: null,
    },
    {
      name: "Basic",
      price: "¥980",
      siCount: "20件まで",
      siDelete: "無制限",
      ocr: "月50回",
      storage: "各ファイル最大10MB・最大4枚（計40MB）",
      inventory: "○",
      support: "通常サポート",
      ai: "月50回まで",
      badge: null,
      button: (
        <Button url={billingLinks.basic} variant="primary" size="medium">
          申し込む
        </Button>
      ),
    },
    {
      name: "Pro",
      price: "¥2,980",
      siCount: "無制限",
      siDelete: "無制限",
      ocr: "無制限",
      storage: "各ファイル最大10MB・最大4枚（計40MB）<br/>※使用状況に応じ制限の可能性あり",
      inventory: "○",
      support: "優先サポート",
      ai: "無制限（※過剰使用時は制限の可能性あり）",
      badge: null,
      button: (
        <Button url={billingLinks.pro} variant="primary" size="medium">
          申し込む
        </Button>
      ),
    },
  ];

  const tableRows = plans.map((plan) => [
    <Text as="span" variant="bodyMd" fontWeight="bold">{plan.name}</Text>,
    plan.price,
    plan.siCount,
    plan.siDelete,
    plan.ocr,
    <span dangerouslySetInnerHTML={{ __html: plan.storage }} />,
    plan.inventory,
    plan.support,
    plan.ai,
    plan.badge || plan.button,
  ]);

  return (
    <Page title="料金プラン">
      <Layout>
        <Layout.Section>
          <Card>
            <Box padding="400">
              <Text as="h2" variant="headingMd">
                料金プラン比較
              </Text>
              <br />
              <Scrollable shadow style={{ maxWidth: "100%", overflowX: "auto" }}>
                <DataTable
                  columnContentTypes={[
                    "text", "text", "text", "text", "text", "text", "text", "text", "text", "text"
                  ]}
                  headings={[
                    "プラン",
                    "月額",
                    "SI登録件数（同時保有）",
                    "SI削除回数（月）",
                    "OCR回数",
                    "INV/PLなどのファイル保存容量制限",
                    "Shopify在庫連携",
                    "サポート",
                    "AI利用回数（Gemini）",
                    "",
                  ]}
                  rows={tableRows}
                  hideScrollIndicator
                />
              </Scrollable>
              <Box paddingBlockStart="400">
                <Text as="span" variant="bodySm" tone="subdued">
                  ※ 申し込みボタンを押すとShopifyの決済画面に遷移します。<br />
                  各プランの内容・料金は予告なく変更される場合があります。詳細はお問い合わせください。
                </Text>
              </Box>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}