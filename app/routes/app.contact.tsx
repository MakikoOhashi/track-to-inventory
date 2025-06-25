import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { Page, Card, Layout, Text, TextField, Button, DropZone, Banner, Box } from "@shopify/polaris";
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';

type LoaderData = {
  shop: string | null;
  isAdmin: boolean;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 認証をスキップ
  return json<LoaderData>({
    shop: null,
    isAdmin: true, // 全員フォーム送信可
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // 認証をスキップ
  // 必要ならshop情報はフォームから取得 or 空文字でOK
  const formData = await request.formData();
  const name = formData.get("name") as string;
  const email = formData.get("email") as string;
  const message = formData.get("message") as string;
  const file = formData.get("file") as File | null;

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
      from: "onboarding@resend.dev",
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
  const { t, i18n } = useTranslation("common");
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { shop, isAdmin, error } = useLoaderData<LoaderData>();

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

  // 通常の<form>でonSubmitハンドラ
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    // バリデーション入れたければここで
  };

  return (
    <Page title={t("contact.title")}>
      <Box paddingBlockEnd="200">
        <div style={{ maxWidth: 200 }}>
          <LanguageSwitcher value={i18n.language} onChange={i18n.changeLanguage} />
        </div>
      </Box>
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: '20px', maxWidth: 500 }}>
              <Text as="h2" variant="headingMd">{t("contact.formTitle")}</Text>
              <br />
              {actionData && 'ok' in actionData && actionData.ok &&(
                <Banner tone="success">{t("contact.success")}</Banner>
              )}
              {actionData && 'error' in actionData && (
                <Banner tone="critical">{actionData.error ?? t("contact.error")}</Banner>
              )}
              <form
                id="contact-form"
                method="post"
                encType="multipart/form-data"
                onSubmit={handleSubmit}
              >
                <TextField
                  label={t('contact.name')}
                  name="name"
                  value={name}
                  onChange={setName}
                  autoComplete="name"
                  disabled={!isAdmin}
                />
                <br />
                <TextField
                  label={t('contact.email')}
                  name="email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                  disabled={!isAdmin}
                />
                <br />
                <TextField
                  label={t('contact.message')}
                  name="message"
                  value={message}
                  onChange={setMessage}
                  multiline={6}
                  autoComplete="off"
                  disabled={!isAdmin}
                />
                <br />
                <DropZone
                  accept="image/*"
                  onDrop={handleDrop}
                  allowMultiple={false}
                  disabled={!isAdmin}
                >
                  {!file ? (
                    <DropZone.FileUpload actionTitle={t('contact.fileUpload')} />
                  ) : (
                    <div>{file.name}</div>
                  )}
                  {/* ファイル添付は「任意」 */}
                  <input type="hidden" name="file" />
                </DropZone>
                <br />
                <Button
                  variant="primary"
                  submit
                  loading={navigation.state === "submitting"}
                  disabled={!isAdmin}
                  aria-disabled={!isAdmin}
                >
                  {t('contact.submit')}
                </Button>
              </form>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}