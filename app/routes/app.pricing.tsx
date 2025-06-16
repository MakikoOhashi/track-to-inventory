// app/routes/app.pricing.tsx
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
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Pricing() {
  // 各プランのShopify Billing用リンク（後で置き換え）
  const billingLinks = {
    free: "#", // 無料プランは申し込み不要
    basic: "https://your-billing-link/basic",  // 仮のリンク。Shopify Billingで発行されたリンクに差し替えてください
    pro: "https://your-billing-link/pro",      // 仮のリンク。Shopify Billingで発行されたリンクに差し替えてください
  };

  // ここで現在プランを取得して判定することもできます
  // const currentPlan = "free" | "basic" | "pro";

  return (
    <Page title="料金プラン">
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: "20px" }}>
              <Text as="h2" variant="headingMd">
                料金プラン
              </Text>
              <br />
              <TextContainer>
                <BlockStack gap="400">
                  {/* 無料プラン */}
                  <Card>
                    <div style={{ padding: "16px" }}>
                      <InlineStack align="space-between" blockAlign="center">
                        <div>
                          <Text as="h3" variant="headingSm">
                            無料プラン
                          </Text>
                          <p>基本機能を無料でご利用いただけます。</p>
                        </div>
                        <Badge tone="success">現在のプラン</Badge>
                      </InlineStack>
                    </div>
                  </Card>

                  {/* ベーシックプラン */}
                  <Card>
                    <div style={{ padding: "16px" }}>
                      <InlineStack align="space-between" blockAlign="center">
                        <div>
                          <Text as="h3" variant="headingSm">
                            ベーシックプラン
                          </Text>
                          <p>
                            追加機能とサポートがご利用いただけます。
                          </p>
                          <Text as="span" variant="bodySm" tone="subdued">
                            月額 ¥1,000（税抜）
                          </Text>
                        </div>
                        <Button
                          url={billingLinks.basic}
                          variant="primary"
                          size="medium"
                        >
                          申し込む
                        </Button>
                      </InlineStack>
                    </div>
                  </Card>

                  {/* プロプラン */}
                  <Card>
                    <div style={{ padding: "16px" }}>
                      <InlineStack align="space-between" blockAlign="center">
                        <div>
                          <Text as="h3" variant="headingSm">
                            プロプラン
                          </Text>
                          <p>
                            すべての機能と優先サポートがご利用いただけます。
                          </p>
                          <Text as="span" variant="bodySm" tone="subdued">
                            月額 ¥3,000（税抜）
                          </Text>
                        </div>
                        <Button
                          url={billingLinks.pro}
                          variant="primary"
                          size="medium"
                        >
                          申し込む
                        </Button>
                      </InlineStack>
                    </div>
                  </Card>
                </BlockStack>
              </TextContainer>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}