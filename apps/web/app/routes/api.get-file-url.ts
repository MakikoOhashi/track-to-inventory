import { data as json, type ActionFunctionArgs } from "react-router";
import { createSignedFileUrls } from "~/lib/ocrBackend.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const locale = resolveRequestLocale(request);
    const ja = isJapaneseRequest(request, locale);
    const body = await request.json();
    const shopId =
      url.searchParams.get("shop_id") ||
      body.shop_id ||
      body.shopId ||
      "";

    if (!shopId) {
      return json({ error: ja ? "shop_idが必要です" : "shop_id is required" }, { status: 401 });
    }

    const requestBody = body;
    const result = await createSignedFileUrls(requestBody, shopId);
    return json(result);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ 
      error: message,
      details: message
    }, { status: message === "ファイルパスが指定されていません" || message === "File path is required" ? 400 : message === "アクセス権限がありません" || message === "Access denied" ? 403 : message === "ファイルが見つかりません" || message === "File not found" ? 404 : 500 });
  }
};
