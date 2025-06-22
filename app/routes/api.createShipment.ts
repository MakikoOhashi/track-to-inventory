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
    const formData = await request.formData();
    const siNumber = formData.get("siNumber") as string;
    const shopId = formData.get("shopId") as string;
    const invoiceUrl = formData.get("invoiceUrl") as string;
    const plUrl = formData.get("plUrl") as string;
    const siUrl = formData.get("siUrl") as string;
    const otherUrl = formData.get("otherUrl") as string;

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

    // 現在の日時を取得
    const now = new Date().toISOString();

    const shipmentData = {
      si_number: siNumber,
      shop_id: shopId,
      status: "SI発行済", // デフォルトステータス
      invoice_url: invoiceUrl || null,
      pl_url: plUrl || null,
      si_url: siUrl || null,
      other_url: otherUrl || null,
      delayed: false, // デフォルト値
      is_archived: false, // デフォルト値
      created_at: now,
      updated_at: now,
    };

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