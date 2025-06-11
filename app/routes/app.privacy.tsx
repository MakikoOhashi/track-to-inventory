// app/routes/app.privacy.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Card, TextContainer, Layout, Text } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Privacy() {
  return (
    <Page title="プライバシーポリシー">
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: '20px' }}>
              <Text as="h2" variant="headingMd">プライバシーポリシー</Text>
              <br />
              <TextContainer>
                <Text as="h3" variant="headingSm">個人情報の収集について</Text>
                <p>
                  当社は、本サービスの提供にあたり、以下の個人情報を収集する場合があります：
                </p>
                <ul style={{ paddingLeft: '20px', marginTop: '10px' }}>
                  <li>ショップ名、メールアドレス</li>
                  <li>サービス利用状況に関する情報</li>
                  <li>お問い合わせ内容</li>
                </ul>
                <br />
                
                <Text as="h3" variant="headingSm">個人情報の利用目的</Text>
                <p>
                  収集した個人情報は、以下の目的で利用いたします：
                </p>
                <ul style={{ paddingLeft: '20px', marginTop: '10px' }}>
                  <li>本サービスの提供・運営のため</li>
                  <li>ユーザーからのお問い合わせに回答するため</li>
                  <li>サービス改善のための分析</li>
                </ul>
                <br />
                
                <Text as="h3" variant="headingSm">個人情報の第三者提供</Text>
                <p>
                  当社は、以下の場合を除いて、あらかじめユーザーの同意を得ることなく、
                  第三者に個人情報を提供することはありません：
                </p>
                <ul style={{ paddingLeft: '20px', marginTop: '10px' }}>
                  <li>法令に基づく場合</li>
                  <li>人の生命、身体または財産の保護のために必要がある場合</li>
                </ul>
                <br />
                
                <Text as="span" variant="bodySm" tone="subdued">
                  最終更新日: 2024年6月11日
                </Text>
              </TextContainer>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}