// app/routes/app.terms.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Card, TextContainer, Layout, Text } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Terms() {
  return (
    <Page title="利用規約">
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: '20px' }}>
              <Text as="h2" variant="headingMd">利用規約</Text>
              <br />
              <TextContainer>
                <Text as="h3" variant="headingSm">第1条（適用）</Text>
                <p>
                  この利用規約（以下、「本規約」といいます。）は、本サービスの利用条件を定めるものです。
                </p>
                <br />
                
                <Text as="h3" variant="headingSm">第2条（利用登録）</Text>
                <p>
                  利用登録は、利用希望者が本規約に同意の上、所定の方法によって利用登録を申請し、
                  当社がこれを承認することによって完了するものとします。
                </p>
                <br />
                
                <Text as="h3" variant="headingSm">第3条（禁止事項）</Text>
                <p>
                  利用者は、本サービスの利用にあたり、以下の行為をしてはなりません：
                </p>
                <ul style={{ paddingLeft: '20px', marginTop: '10px' }}>
                  <li>法令または公序良俗に違反する行為</li>
                  <li>犯罪行為に関連する行為</li>
                  <li>本サービスの内容等、本サービスに含まれる著作権、商標権ほか知的財産権を侵害する行為</li>
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