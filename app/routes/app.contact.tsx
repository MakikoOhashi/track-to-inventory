import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, Form, useNavigation } from "@remix-run/react";
import { Page, Card, Layout, Text, TextField, Button, DropZone, Banner } from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "~/shopify.server";

// 認証
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

// お問い合わせフォームのメール送信（Resend利用）＋reCAPTCHA検証
export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const name = formData.get("name") as string;
  const email = formData.get("email") as string;
  const message = formData.get("message") as string;
  const recaptcha = formData.get("g-recaptcha-response") as string;
  const file = formData.get("file") as File | null;

  // reCAPTCHA検証（オプション・サイトキー/シークレットは .env で管理推奨）
  if (!recaptcha) {
    return json({ error: "reCAPTCHA認証に失敗しました。" }, { status: 400 });
  }
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  const verifyRes = await fetch(
    `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${recaptcha}`,
    { method: "POST" }
  );
  const verifyData = await verifyRes.json();
  if (!verifyData.success) {
    return json({ error: "reCAPTCHA検証に失敗しました。" }, { status: 400 });
  }

  // Resendでメール送信
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const attachments = [];
  if (file && file.size > 0) {
    const arrayBuffer = await file.arrayBuffer();
    attachments.push({
      filename: file.name,
      content: Buffer.from(arrayBuffer),
    });
  }
  try {
    await resend.emails.send({
      from: "onboarding@resend.dev", // ご自身のドメインに合わせてください
      to: "makiron19831014@gmail.com",
      subject: `お問い合わせ from ${name}`,
      text: `名前: ${name}\nメール: ${email}\n内容: ${message}`,
      attachments,
    });
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "メール送信に失敗しました。" }, { status: 500 });
  }
};

export default function Contact() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  // Polaris用state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);

  // DropZone
  const handleDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[], _rejectedFiles: File[]) => {
      setFile(acceptedFiles && acceptedFiles.length > 0 ? acceptedFiles[0] : null);
    },
    []
  );

  return (
    <Page title="お問い合わせ">
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: '20px', maxWidth: 500 }}>
              <Text as="h2" variant="headingMd">お問い合わせフォーム</Text>
              <br />
              {actionData && 'ok' in actionData && actionData.ok &&(
                <Banner tone="success">送信が完了しました！</Banner>
              )}
              {actionData && 'error' in actionData && (
                <Banner tone="critical">{actionData.error}</Banner>
              )}
              <Form method="post" encType="multipart/form-data">
                <TextField
                  label="お名前"
                  name="name"
                  value={name}
                  onChange={setName}
                  autoComplete="name"
                  
                />
                <br />
                <TextField
                  label="メールアドレス"
                  name="email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                  
                />
                <br />
                <TextField
                  label="お問い合わせ内容"
                  name="message"
                  value={message}
                  onChange={setMessage}
                  multiline={6}
                  autoComplete="off"
                />
                <br />
                <DropZone
                  accept="image/*"
                  onDrop={handleDrop}
                  allowMultiple={false}
                >
                  {!file ? (
                    <DropZone.FileUpload actionTitle="画像ファイルをここにドラッグ＆ドロップ、またはクリックで選択" />
                  ) : (
                    <div>{file.name}</div>
                  )}
                  {/* ファイル添付は「任意」 */}
                  <input type="hidden" name="file" />
                </DropZone>
                <br />
                {/* reCAPTCHA (v2) */}
                <div style={{ marginBottom: 20, marginTop: 10 }}>
                  <div
                    className="g-recaptcha"
                    data-sitekey={process.env.RECAPTCHA_SITE_KEY}
                  ></div>
                </div>
                <Button variant="primary" submit loading={navigation.state === "submitting"}>送信</Button>
              </Form>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
      {/* reCAPTCHAスクリプト */}
      <script src="https://www.google.com/recaptcha/api.js" async defer></script>
    </Page>
  );
}