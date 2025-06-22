// app/routes/api.usage.js
import { json } from "@remix-run/node";
import { getUserUsage } from "~/lib/redis.server";

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const shopId = url.searchParams.get('shop_id') || url.searchParams.get('shopId');
    
    if (!shopId) {
      return json({ 
        error: "shop_id parameter is required",
        usage: null 
      }, { status: 400 });
    }
    
    // ストアIDを直接渡して使用状況を取得
    const usage = await getUserUsage(shopId);
    
    return json({ 
      success: true, 
      usage 
    });
  } catch (error) {
    console.error("使用状況取得エラー:", error);
    return json({ 
      error: "使用状況の取得に失敗しました",
      usage: null 
    }, { status: 500 });
  }
}