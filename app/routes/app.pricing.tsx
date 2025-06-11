// app/routes/app.pricing.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Card, TextContainer, Layout, Text, InlineStack, BlockStack, Badge } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Pricing() {
  return (
    <Page title="料金プラン">
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: '20px' }}>
              <Text as="h2" variant="headingMd">料金プラン</Text>
              <br />
              <TextContainer>
                <BlockStack gap="400">
                  <Card>
                    <div style={{ padding: '16px' }}>
                      <InlineStack align="space-between" blockAlign="center">
                        <div>
                          <Text as="h3" variant="headingSm">無料プラン</Text>
                          <p>基本機能をご利用いただけます</p>
                        </div>
                        <Badge tone="success">現在のプラン</Badge>
                      </InlineStack>
                    </div>
                  </Card>
                  
                  <Card>
                    <div style={{ padding: '16px' }}>
                      <InlineStack align="space-between" blockAlign="center">
                        <div>
                          <Text as="h3" variant="headingSm">プレミアムプラン</Text>
                          <p>高度な機能と優先サポート</p>
                          <Text as="span" variant="bodySm" tone="subdued">
                            料金についてはお問い合わせください
                          </Text>
                        </div>
                        <Badge>お問い合わせ</Badge>
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