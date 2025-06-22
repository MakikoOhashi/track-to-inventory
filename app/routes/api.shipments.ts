//app/routes/api.shipments.ts
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';
import type { ActionFunctionArgs } from "@remix-run/node"
import { checkSILimitFromRequest } from "~/lib/redis.server"
import crypto from "crypto";

// HMAC検証関数
export function verifyShopifyHmac(query: URLSearchParams, secret: string): boolean {
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
  const generated = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");
  return generated === hmac;
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET!;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

    // ★★★ 修正：hmacがある時だけ検証する ★★★
    const hmac = url.searchParams.get("hmac");
    if (hmac) {
      if (!verifyShopifyHmac(url.searchParams, SHOPIFY_API_SECRET)) {
        return json({ error: "HMAC validation failed" }, { status: 401 });
      }
    }
    // hmacが無い場合はスキップ

  const shop_id = url.searchParams.get("shop_id");
  if (!shop_id) {
    return json({ error: "shop_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('shipments')
    .select('*')
    .eq('shop_id', shop_id);

  if (error) {
    return json({ error: error.message }, { status: 500 });
  }
  return json({ data });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);

  // --- HMAC検証を最初に追加 ---
  if (!verifyShopifyHmac(url.searchParams, SHOPIFY_API_SECRET)) {
    return json({ error: "HMAC validation failed" }, { status: 401 });
  }

  if (request.method === "POST") {
    try {
      await checkSILimitFromRequest(request)
    } catch (error) {
      return json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'SI登録制限チェックでエラーが発生しました'
        },
        { status: 403 }
      )
    }
  }

  
  // 制限チェック通過後、実際のSI登録処理を実行
  // ... 既存のSupabase登録処理
  
  return json({ success: true })
}