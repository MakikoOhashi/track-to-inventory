// app/routes/app.contact.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Card, TextContainer, Layout, Text, Button, Link } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Contact() {
  return (
    <Page title="お問い合わせ">
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: '20px' }}>
              <Text as="h2" variant="headingMd">お問い合わせ方法</Text>
              <br />
              <TextContainer>
                <p>ご質問やサポートが必要な場合は、以下の方法でお問い合わせください。</p>
                <br />
                <Text as="h3" variant="headingSm">メールでのお問い合わせ</Text>
                <p>
                  <Link url="mailto:support@example.com">support@example.com</Link>
                </p>
                <br />
                <Text as="h3" variant="headingSm">お問い合わせフォーム</Text>
                <p>下記のGoogleフォームからもお問い合わせいただけます。</p>
                <br />
                <Button 
                  url="https://forms.google.com/your-form-id" 
                  external
                  variant="primary"
                >
                  お問い合わせフォームを開く
                </Button>
              </TextContainer>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
