import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { createSignedFileUrls } from "~/lib/ocrBackend.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Shopifyセッション認証（ページルートからの呼び出しの場合）
    let shopId: string;
    let body: any | null = null;
    try {
      const { session } = await authenticate.admin(request);
      shopId = session.shop;
    } catch (authError) {
      // 認証に失敗した場合は、リクエストボディからshop_idを取得
      body = await request.json();
      shopId = body.shopId;
      
      if (!shopId) {
        return json({ error: "shop_idが必要です" }, { status: 401 });
      }
    }

    const requestBody = body ?? await request.json();
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
