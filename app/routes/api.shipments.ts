//app/routes/api.shipments.ts
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';
import type { ActionFunctionArgs } from "@remix-run/node"
import { checkSILimitFromRequest } from "~/lib/redis.server"


const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
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
  // POSTの場合（新規SI登録）のみ制限チェック
  if (request.method === "POST") {
    try {
      // SI登録前に制限チェック
      await checkSILimitFromRequest(request)
    } catch (error) {
      return json(
        { 
          success: false, 
          error: error instanceof Error ? error.message : 'SI登録制限チェックでエラーが発生しました' 
        },
        { status: 403 } // Forbidden
      )
    }
  }
  
  // 制限チェック通過後、実際のSI登録処理を実行
  // ... 既存のSupabase登録処理
  
  return json({ success: true })
}