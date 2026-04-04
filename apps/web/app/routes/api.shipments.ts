//app/routes/api.shipments.ts
import { data as json, type LoaderFunctionArgs } from "react-router";
import { createClient } from '@supabase/supabase-js';
import type { ActionFunctionArgs } from "react-router"
import { checkSILimit } from "~/lib/redis.server"
import { authenticate } from "~/shopify.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// HMAC検証関数
export async function verifyShopifyHmac(query: URLSearchParams, secret: string): Promise<boolean> {
  const params: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    params[key] = value;
  }
  const { hmac, ...rest } = params;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const generated = toHex(signature);

  return generated === hmac;
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET!;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const url = new URL(request.url);
    const locale = resolveRequestLocale(request);
    const ja = isJapaneseRequest(request, locale);
    const requestedShopId = url.searchParams.get("shop_id") || "";
    let shopId = requestedShopId;

    if (!shopId) {
      // query がない場合だけ Shopify 認証にフォールバック
      const { session } = await authenticate.admin(request);
      shopId = session.shop;
    }

    if (!shopId) {
      return json({ error: ja ? "認証に失敗しました" : "Authentication failed" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('shipments')
      .select('*')
      .eq('shop_id', shopId);

    if (error) {
      console.error('Supabase error:', error);
      return json({ error: ja ? "データベースエラーが発生しました" : "Database error" }, { status: 500 });
    }
    
    return json({ shipments: data || [] });
  } catch (error) {
    console.error('Authentication error:', error);
    return json({ error: isJapaneseRequest(request, resolveRequestLocale(request)) ? "認証に失敗しました" : "Authentication failed" }, { status: 401 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);

  // --- HMAC検証を最初に追加 ---
  if (!(await verifyShopifyHmac(url.searchParams, SHOPIFY_API_SECRET))) {
    return json({ error: "HMAC validation failed" }, { status: 401 });
  }

  if (request.method === "POST") {
    try {
      const shop_id = url.searchParams.get("shop_id");
      if (!shop_id) {
        return json({ error: isJapaneseRequest(request, resolveRequestLocale(request)) ? "shop_idが必要です" : "shop_id is required" }, { status: 400 });
      }
      await checkSILimit(shop_id);
    } catch (error) {
      return json(
        {
          success: false,
          error: error instanceof Error ? error.message : (isJapaneseRequest(request, resolveRequestLocale(request)) ? 'SI登録制限チェックでエラーが発生しました' : 'Failed to check SI usage limit')
        },
        { status: 403 }
      )
    }
  }

  
  // 制限チェック通過後、実際のSI登録処理を実行
  // ... 既存のSupabase登録処理
  
  return json({ success: true })
}
