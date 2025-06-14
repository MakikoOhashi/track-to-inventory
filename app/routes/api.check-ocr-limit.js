// app/routes/api.check-ocr-limit.js
import { json } from "@remix-run/node";
import { checkAndIncrementOCRFromRequest } from "~/lib/redis.server";

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // OCR使用制限をチェック＆インクリメント
    await checkAndIncrementOCRFromRequest(request);
    
    return json({ success: true });
  } catch (error) {
    console.error("OCR制限チェックエラー:", error);
    
    // 使用回数制限エラーの場合は429ステータスを返す
    if (error.message.includes("OCR使用回数の月間上限")) {
      return json({ error: error.message }, { status: 429 });
    }
    
    return json({ error: "OCR制限チェックに失敗しました" }, { status: 500 });
  }
}