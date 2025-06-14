// app/routes/api.usage.js
import { json } from "@remix-run/node";
import { getUserUsageFromRequest } from "~/lib/redis.server";

export async function loader({ request }) {
  try {
    // リクエストからストアIDを取得して使用状況を取得
    const usage = await getUserUsageFromRequest(request);
    
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