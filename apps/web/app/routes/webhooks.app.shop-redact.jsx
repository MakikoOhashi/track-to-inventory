import { authenticate } from "~/shopify.server";

export const action = async ({ request }) => {
  // Shopify Webhook認証 & ペイロード取得
  const payload = await authenticate.webhook(request);

  // ログ出力
  console.log("GDPR ショップデータ消去リクエスト受信:", payload);

  // Shopifyには200 OKで即時応答すればOK
  return new Response("ok");
};