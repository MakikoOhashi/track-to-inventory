import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { checkSILimit } from "~/lib/redis.server";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase環境変数が設定されていません");
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
    const contentType = request.headers.get('content-type');
    let siNumber: string;
    let shopId: string;
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
      
      if (!shipment) {
        return json({ error: "shipment data is required" }, { status: 400 });
      }
      
      // created_at, updated_atフィールドを明示的に除外
      const { created_at, updated_at, ...cleanShipment } = shipment;
      
      siNumber = cleanShipment.si_number;
      shopId = cleanShipment.shop_id;
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
      shopId = formData.get("shopId") as string;
      supplierName = formData.get("supplierName") as string;
      transportType = formData.get("transportType") as string;
      const itemsStr = formData.get("items") as string;
      items = itemsStr ? JSON.parse(itemsStr) : [];
      invoiceUrl = formData.get("invoiceUrl") as string;
      plUrl = formData.get("plUrl") as string;
      siUrl = formData.get("siUrl") as string;
      otherUrl = formData.get("otherUrl") as string;
    } else {
      return json({ error: "Unsupported content type" }, { status: 400 });
    }

    if (!siNumber || !shopId) {
      return json({ error: "必須フィールドが不足しています" }, { status: 400 });
    }

    // SI番号の重複チェック
    const { data: existingShipment, error: checkError } = await supabase
      .from("shipments")
      .select("si_number")
      .eq("si_number", siNumber)
      .eq("shop_id", shopId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116は「見つからない」エラー
      console.error("重複チェックエラー:", checkError);
      return json({ error: "データベースエラーが発生しました" }, { status: 500 });
    }

    if (existingShipment) {
      return json({ error: "このSI番号は既に登録されています" }, { status: 409 });
    }

    // SI登録件数制限チェック
    try {
      await checkSILimit(shopId);
    } catch (error) {
      return json({ 
        error: error instanceof Error ? error.message : "SI登録件数の上限に達しました" 
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

    console.log('📤 Supabaseに保存するデータ:', shipmentData);

    const { data: result, error: shipmentError } = await supabase
      .from("shipments")
      .insert([shipmentData])
      .select()
      .single();

    if (shipmentError) {
      console.error("Shipment creation error:", shipmentError);
      
      // 一意制約違反の詳細なエラーハンドリング
      if (shipmentError.code === '23505') {
        return json({ error: "このSI番号は既に登録されています" }, { status: 409 });
      }
      
      return json({ 
        error: "データの保存に失敗しました",
        details: shipmentError.message 
      }, { status: 500 });
    }

    return json({ 
      success: true, 
      data: result,
      message: "SIが正常に登録されました"
    });
  } catch (error) {
    console.error("Create shipment error:", error);
    return json({ 
      error: "内部サーバーエラーが発生しました",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
};