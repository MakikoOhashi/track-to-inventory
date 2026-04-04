import { data as json, type ActionFunctionArgs } from "react-router";
import { generateGeminiContent } from "~/lib/geminiClient";
import { checkAndIncrementAI } from "~/lib/redis.server";
import { authenticate } from "~/shopify.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

type Fields = { [key: string]: string | string[] };
type RequestBody = { text: string; fields: Fields };

// POST専用API
export const action = async ({ request }: ActionFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return json({ error: ja ? "JSONが不正です" : "Invalid JSON" }, { status: 400 });
  }

  const { text, fields } = body || {};
  if (!text) {
    return json({ error: ja ? "テキストがありません" : "Missing text" }, { status: 400 });
  }

  // 未入力項目だけリストアップ
  const missing = Object.entries(fields ?? {}).filter(([_, v]) => {
    if (Array.isArray(v)) return v.length === 0;
    return !v || (typeof v === "string" && v.trim() === "");
  }).map(([k]) => k);

  if (missing.length === 0) {
    return json({ result: "{}" });
  }
  
  // 🔥 AI使用制限チェック（ここで回数制限＆カウント増加）
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

    await checkAndIncrementAI(shopId);
  } catch (error) {
    // 認証エラーの場合は401を返す
    const errorMessage =
      error instanceof Error
        ? error.message
        : error instanceof Response
          ? `HTTP ${error.status}`
          : String(error);
    if (errorMessage.includes("認証に失敗しました") || errorMessage.includes("shop_id parameter is required")) {
      return json({ 
        error: ja ? "認証に失敗しました。アプリを再インストールしてください。" : "Authentication failed. Please reinstall the app.",
        type: "auth_error"
      }, { status: 401 });
    }
    
    // 制限に達した場合は429エラーを返す
    return json(
      { 
        error: errorMessage,
        type: "usage_limit"
      }, 
      { status: 429 }
    );
  }


  // AIへのプロンプト設計
  const prompt = `
    次のShipping Documentsテキストから、以下の項目を推測し、各項目名・形式は必ず下記の通り返してください。
    あなたは請求書・船積書類のOCRテキストから情報を抽出するAIです。

    【必ず守るルール】
    - 回答は**JSONオブジェクトのみ**で返してください。自然言語、解説文、余計な出力は禁止です。
    - **絶対に下記のフィールド名・形式のみで返してください**。項目名・配列名・型は変更禁止です。

    不足項目: ${missing.join(", ")}

    【出力するフィールド】
    - si_number（文字列）
    - supplier_name（文字列）
    - transport_type（文字列）
    - items（配列。要素は下記4つのプロパティを持つオブジェクト）
        - name（文字列、商品名または商品説明）
        - quantity（数字だけ。単位やカンマ、空白はいらない）
        - product_code（文字列。なければ空文字でOK）
        - unit_price（文字列。なければ空文字でOK）

    既に判明している項目:
    ${Object.entries(fields ?? {}).filter(([_, v]) => {
      if (Array.isArray(v)) return v.length > 0;
      return v && (typeof v === "string" ? v.trim() !== "" : true);
    }).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? `[${v.length}件の商品]` : v}`).join("\n")}

    原文:
    ${text}

    返答例:
    {
      "si_number": "SN13/10-0005",
      "supplier_name": "SUNPLAN SOFT CO., LTD",
      "transport_type": "NIPPON MARU",
      "items": [
        {"name": "LED1102B Chip LED Blue", "quantity": "10000"},
        {"name": "LED1102G Chip LED Green", "quantity": "10000"},
        {"name": "LED953S Chip LED SET", "quantity": "1000"}
      ]
    }
    `;

  try {
    const aiText = await generateGeminiContent(prompt);
    // ```json ブロックがある場合は抽出
    let cleanedJson = aiText;
    const jsonMatch = aiText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      cleanedJson = jsonMatch[1];
    }

    // JSONの妥当性をチェック
    try {
      JSON.parse(cleanedJson);
      return json({ result: cleanedJson });
    } catch (parseError) {
      return json({ result: "{}" });
    }
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, { status: 500 });
  }
};
