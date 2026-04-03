import { data as json, type ActionFunctionArgs } from "react-router";
import { createSignedFileUrls } from "~/lib/ocrBackend.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const body = await request.json();
    const shopId =
      url.searchParams.get("shop_id") ||
      body.shop_id ||
      body.shopId ||
      "";

    if (!shopId) {
      return json({ error: "shop_idが必要です" }, { status: 401 });
    }

    const requestBody = body;
    const result = await createSignedFileUrls(requestBody, shopId);
    return json(result);

  } catch (error) {
    console.error('Error generating signed URLs:', error);
    const message = error instanceof Error ? error.message : String(error);
    return json({ 
      error: message,
      details: message
    }, { status: message === "ファイルパスが指定されていません" ? 400 : message === "アクセス権限がありません" ? 403 : message === "ファイルが見つかりません" ? 404 : 500 });
  }
};
