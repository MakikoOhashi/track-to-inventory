import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { Page, Card, Layout, Text, TextField, Button, DropZone, Banner } from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "~/shopify.server";
import { useTranslation } from "react-i18next";

type LoaderData = {
  shop: string | null;
  isAdmin: boolean;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const ctx = await authenticate.admin(request);
    const shop = ctx.session?.shop ?? null;
    return json<LoaderData>({
      shop,
      isAdmin: !!shop, // shopが取得できた場合のみフォーム送信許可
    });
  } catch (e) {
    return json<LoaderData>({
      shop: null,
      isAdmin: false,
      error: "Shopify管理者のみアクセスできます。ログインし直してください。",
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  let shop = "";
  try {
    const ctx = await authenticate.admin(request);
    shop = ctx.session?.shop ?? "";
    if (!shop) {
      return json({ error: "ストアIDが取得できません。Shopify管理者として再ログインしてください。" }, { status: 401 });
    }
  } catch {
    return json({ error: "Shopify認証エラー。再ログインしてください。" }, { status: 401 });
  }

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
      subject: `お問い合わせ from ${name} [${shop}]`,
      text: `ショップ: ${shop}\n名前: ${name}\nメール: ${email}\n内容: ${message}`,
      attachments,
    });
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "メール送信に失敗しました。" }, { status: 500 });
  }
};

export default function Contact() {
  const { t } = useTranslation("common");
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
      <Layout>
        <Layout.Section>
          <Card>
            <div style={{ padding: '20px', maxWidth: 500 }}>
              <Text as="h2" variant="headingMd">{t("contact.formTitle")}</Text>
              <br />
              <div style={{ marginBottom: "1em", fontSize: "0.9em", color: "#666" }}>
                {t("contact.shopLabel")}: <b>{shop ?? t("contact.unknown")}</b>
              </div>
              {!isAdmin && (
                <Banner tone="critical">
                  {error ?? t("contact.adminOnly")}
                </Banner>
              )}
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
                  label="お名前"
                  name="name"
                  value={name}
                  onChange={setName}
                  autoComplete="name"
                  disabled={!isAdmin}
                />
                <br />
                <TextField
                  label="メールアドレス"
                  name="email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                  disabled={!isAdmin}
                />
                <br />
                <TextField
                  label="お問い合わせ内容"
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
                    <DropZone.FileUpload actionTitle="画像ファイルをここにドラッグ＆ドロップ、またはクリックで選択" />
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
                  送信
                </Button>
              </form>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}