import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { Page, Card, Layout, Text, TextField, Button, DropZone, Banner } from "@shopify/polaris";
import { useState, useCallback, useRef, useEffect } from "react";
import { authenticate } from "~/shopify.server";

// 認証＋reCAPTCHA SITE KEYを渡す
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({
    RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY, // サーバーから渡す
  });
};

// お問い合わせフォームのメール送信（Resend利用）＋reCAPTCHA検証
export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const name = formData.get("name") as string;
  const email = formData.get("email") as string;
  const message = formData.get("message") as string;
  const recaptcha = formData.get("g-recaptcha-response") as string;
  const file = formData.get("file") as File | null;

  // reCAPTCHA検証
  if (!recaptcha) {
    return json({ error: "reCAPTCHA認証に失敗しました。" }, { status: 400 });
  }
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  if (!secretKey) throw new Error("RECAPTCHA_SECRET_KEY is not set");
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
  const { RECAPTCHA_SITE_KEY } = useLoaderData<typeof loader>();

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

  // reCAPTCHAトークン用ref
  const recaptchaRef = useRef<HTMLInputElement>(null);

  // reCAPTCHAコールバック登録（windowグローバルに関数を用意）
  useEffect(() => {
    // @ts-ignore
    window.onRecaptchaSuccess = (token: string) => {
      if (recaptchaRef.current) recaptchaRef.current.value = token;
      // Polarisの<Form>はonSubmitが効かないので、通常の<form>でsubmit
      (document.getElementById("contact-form")as HTMLFormElement)?.submit();
    };
  }, []);

  // 通常の<form>でonSubmitハンドラ
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // v2 invisibleの場合はexecute()を呼ぶ。checkboxの場合は不要。
    // window.grecaptcha.execute();
    // checkboxの場合はsubmit時にtokenがhidden inputに入っていればOK
    // ここでは念のためtokenチェックし、不足ならalert
    if (!recaptchaRef.current?.value) {
      alert("reCAPTCHAを完了してください。");
      return;
    }
    e.currentTarget.submit();
  };

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
                {/* reCAPTCHA v2 checkbox版 */}
                <input type="hidden" name="g-recaptcha-response" ref={recaptchaRef} />
                <div style={{ marginBottom: 20, marginTop: 10 }}>
                  <div
                    className="g-recaptcha"
                    data-sitekey={RECAPTCHA_SITE_KEY}
                    data-callback="onRecaptchaSuccess"
                  ></div>
                </div>
                <Button variant="primary" submit loading={navigation.state === "submitting"}>送信</Button>
              </form>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
      {/* reCAPTCHAスクリプト */}
      <script src="https://www.google.com/recaptcha/api.js" async defer></script>
    </Page>
  );
}