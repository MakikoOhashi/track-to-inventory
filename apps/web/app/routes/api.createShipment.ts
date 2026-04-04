import { data as json, type ActionFunctionArgs } from "react-router";
import { createClient } from "@supabase/supabase-js";
import { checkSILimit } from "~/lib/redis.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase environment variables are not configured");
}

const supabase = createClient(supabaseUrl, supabaseKey);

type ShipmentItem = {
  name: string;
  quantity: number | string;
  product_code?: string;
  unit_price?: string;
};

type Shipment = {
  si_number: string;
  supplier_name: string;
  transport_type?: string;
  items: ShipmentItem[];
  status?: string;
  etd?: string;
  eta?: string;
  delayed?: boolean;
  clearance_date?: string;
  arrival_date?: string;
  memo?: string;
  shop_id?: string;
  is_archived?: boolean;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const locale = resolveRequestLocale(request);
    const ja = isJapaneseRequest(request, locale);
    const contentType = request.headers.get('content-type');
    const shopIdFromQuery = url.searchParams.get("shop_id") || "";
    let siNumber: string;
    let requestedShopId: string | null = null;
    let supplierName: string;
    let transportType: string;
    let items: any[];
    let invoiceUrl: string;
    let plUrl: string;
    let siUrl: string;
    let otherUrl: string;

    // Content-Typeに応じて適切に解析
    if (contentType?.includes('application/json')) {
      const body = await request.json();
      const shipment = body.shipment;
      const bodyShopId = body.shop_id ?? body.shopId ?? "";
      
      if (!shipment) {
        return json({ error: ja ? "配送データが必要です" : "Shipment data is required" }, { status: 400 });
      }
      
      // created_at, updated_atフィールドを明示的に除外
      const { created_at, updated_at, ...cleanShipment } = shipment;
      
      siNumber = cleanShipment.si_number;
      requestedShopId = cleanShipment.shop_id ?? bodyShopId ?? null;
      supplierName = cleanShipment.supplier_name;
      transportType = cleanShipment.transport_type;
      items = cleanShipment.items || [];
      invoiceUrl = cleanShipment.invoice_url;
      plUrl = cleanShipment.pl_url;
      siUrl = cleanShipment.si_url;
      otherUrl = cleanShipment.other_url;
    } else if (contentType?.includes('multipart/form-data') || contentType?.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
      siNumber = formData.get("siNumber") as string;
      requestedShopId = (formData.get("shopId") as string) || (formData.get("shop_id") as string) || null;
      supplierName = formData.get("supplierName") as string;
      transportType = formData.get("transportType") as string;
      const itemsStr = formData.get("items") as string;
      items = itemsStr ? JSON.parse(itemsStr) : [];
      invoiceUrl = formData.get("invoiceUrl") as string;
      plUrl = formData.get("plUrl") as string;
      siUrl = formData.get("siUrl") as string;
      otherUrl = formData.get("otherUrl") as string;
    } else {
      return json({ error: ja ? "未対応のContent-Typeです" : "Unsupported content type" }, { status: 400 });
    }

    const shopId = shopIdFromQuery || requestedShopId || "";

    if (!siNumber) {
      return json({ error: ja ? "必須フィールドが不足しています" : "Required fields are missing" }, { status: 400 });
    }

    if (!shopId) {
      return json({ error: ja ? "認証に失敗しました" : "Authentication failed", details: "shop_id is required" }, { status: 401 });
    }

    if (requestedShopId && requestedShopId !== shopId) {
      return json({ error: ja ? "リクエストのshop_idが一致しません" : "Request shop_id mismatch" }, { status: 403 });
    }

    // SI番号の重複チェック
    const { data: existingShipment, error: checkError } = await supabase
      .from("shipments")
      .select("si_number")
      .eq("si_number", siNumber)
      .eq("shop_id", shopId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116は「見つからない」エラー
      return json({ error: ja ? "データベースエラーが発生しました" : "Database error" }, { status: 500 });
    }

    if (existingShipment) {
      return json({ error: ja ? "このSI番号は既に登録されています" : "This SI number is already registered" }, { status: 409 });
    }

    // SI登録件数制限チェック
    try {
      await checkSILimit(shopId);
    } catch (error) {
      return json({ 
        error: error instanceof Error ? error.message : (ja ? "SI登録件数の上限に達しました" : "SI registration limit reached")
      }, { status: 403 });
    }

    const shipmentData = {
      si_number: siNumber,
      shop_id: shopId,
      supplier_name: supplierName || null,
      transport_type: transportType || null,
      items: items, // JSONBフィールドとして保存
      status: "SI発行済", // デフォルトステータス
      invoice_url: invoiceUrl || null,
      pl_url: plUrl || null,
      si_url: siUrl || null,
      other_url: otherUrl || null,
      delayed: false, // デフォルト値
      is_archived: false, // デフォルト値
    };

    const { data: result, error: shipmentError } = await supabase
      .from("shipments")
      .insert([shipmentData])
      .select()
      .single();

    if (shipmentError) {
      
      // 一意制約違反の詳細なエラーハンドリング
      if (shipmentError.code === '23505') {
        return json({ error: ja ? "このSI番号は既に登録されています" : "This SI number is already registered" }, { status: 409 });
      }
      
      return json({ 
        error: ja ? "データの保存に失敗しました" : "Failed to save data",
        details: shipmentError.message 
      }, { status: 500 });
    }

    return json({ 
      success: true, 
      data: result,
      message: ja ? "SIが正常に登録されました" : "SI was registered successfully"
    });
  } catch (error) {
    return json({ 
      error: (isJapaneseRequest(request, resolveRequestLocale(request)) ? "内部サーバーエラーが発生しました" : "Internal server error"),
      details:
        error instanceof Error
          ? error.message
          : error instanceof Response
            ? `HTTP ${error.status}`
            : String(error)
    }, { status: 500 });
  }
};
