// app/routes/api.check-ocr-limit.js
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { checkAndIncrementOCR } from "~/lib/redis.server";

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Shopify認証を実行
    const { session } = await authenticate.admin(request);
    const shopId = session.shop;
    console.log('✅ Shopify authentication successful, shopId:', shopId);

    // OCR使用制限をチェック＆インクリメント
    await checkAndIncrementOCR(shopId);
    
    return json({ success: true });
  } catch (error) {
    console.error("OCR制限チェックエラー:", error);
    
    // 認証エラーの場合は401を返す
    if (error.message.includes("認証に失敗しました") || error.message.includes("shop_id parameter is required")) {
      return json({ 
        error: "認証に失敗しました。アプリを再インストールしてください。",
        type: "auth_error"
      }, { status: 401 });
    }
    
    // 使用回数制限エラーの場合は429ステータスを返す
    if (error.message.includes("OCR使用回数の月間上限")) {
      return json({ error: error.message }, { status: 429 });
    }
    
    return json({ error: "OCR制限チェックに失敗しました" }, { status: 500 });
  }
}