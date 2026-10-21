// app/routes/api.usage.js
import { data as json } from "react-router";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { getUsageForDisplay } from "~/lib/usageGateway.server";
import { assertRequestedShopMatches, requireAdminShop } from "~/lib/requireAdminShop.server";

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const locale = resolveRequestLocale(request);
    const ja = isJapaneseRequest(request, locale);

    const auth = await requireAdminShop(request);
    if (!auth.ok) {
      return json({ error: ja ? "認証に失敗しました" : "Authentication failed", usage: null }, { status: auth.status });
    }
    const requestedShop = url.searchParams.get("shop_id") || url.searchParams.get("shopId");
    if (!assertRequestedShopMatches(auth.shop, requestedShop)) {
      return json({ error: ja ? "店舗指定が認証情報と一致しません" : "Requested shop does not match the authenticated shop", usage: null }, { status: 403 });
    }
    const usage = await getUsageForDisplay(auth.shop);
    
    return json({ 
      success: true, 
      usage 
    });
  } catch (error) {
    return json({ 
      error: isJapaneseRequest(request, resolveRequestLocale(request)) ? "使用状況の取得に失敗しました" : "Failed to fetch usage information",
      usage: null 
    }, { status: 500 });
  }
}
