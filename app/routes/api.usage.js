// app/routes/api.usage.js
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getUserUsage } from "~/lib/redis.server";

export async function loader({ request }) {
  try {
    let shopId;
    
    // 1. Shopify認証を試行
    try {
      const { session } = await authenticate.admin(request);
      shopId = session.shop;
      console.log('Shopify session shop:', shopId);
    } catch (authError) {
      console.log('Shopify auth failed, trying URL params:', authError.message);
      
      // 2. 認証に失敗した場合はURLパラメータから取得
      const url = new URL(request.url);
      shopId = url.searchParams.get('shop_id') || url.searchParams.get('shopId');
      
      if (!shopId) {
        console.error('No shop_id found in URL params');
        return json({ 
          error: "shop_id parameter is required",
          usage: null 
        }, { status: 400 });
      }
    }
    
    console.log('Using shop_id:', shopId);
    
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