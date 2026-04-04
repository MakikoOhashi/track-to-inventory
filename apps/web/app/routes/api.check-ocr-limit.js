// app/routes/api.check-ocr-limit.js
import { data as json } from "react-router";
import { authenticate } from "~/shopify.server";
import { checkAndIncrementOCR } from "~/lib/redis.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

export async function action({ request }) {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const shopIdFromQuery = url.searchParams.get("shop_id") || "";
    let shopId = shopIdFromQuery;

    if (!shopId) {
      // query がない場合だけ Shopify 認証にフォールバック
      const { session } = await authenticate.admin(request);
      shopId = session.shop;
    } else {
    }

    // OCR使用制限をチェック＆インクリメント
    await checkAndIncrementOCR(shopId);
    
    return json({ success: true });
  } catch (error) {
    
    // 認証エラーの場合は401を返す
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage === "AUTH_FAILED" || errorMessage.includes("認証に失敗しました") || errorMessage.includes("shop_id parameter is required")) {
      return json({ 
        error: ja ? "認証に失敗しました。アプリを再インストールしてください。" : "Authentication failed. Please reinstall the app.",
        type: "auth_error"
      }, { status: 401 });
    }
    
    // 使用回数制限エラーの場合は429ステータスを返す
    if (errorMessage === "OCR_LIMIT_EXCEEDED" || errorMessage.includes("OCR使用回数の上限") || errorMessage.includes("OCR使用回数の月間上限")) {
      return json({ error: ja ? "OCR使用回数の月間上限に達しました。プランをアップグレードしてください。" : "You have exceeded the monthly OCR usage limit. Please upgrade your plan.", type: "usage_limit" }, { status: 429 });
    }
    
    return json({ error: ja ? "OCR制限チェックに失敗しました" : "Failed to check OCR usage limit" }, { status: 500 });
  }
}
