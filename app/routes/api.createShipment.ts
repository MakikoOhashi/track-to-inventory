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
      return json({ error: "Missing required fields" }, { status: 400 });
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
      invoice_url: invoiceUrl || null,
      pl_url: plUrl || null,
      si_url: siUrl || null,
      other_url: otherUrl || null,
    };

    const { data: result, error: shipmentError } = await supabase
      .from("shipments")
      .insert([shipmentData])
      .select()
      .single();

    if (shipmentError) {
      console.error("Shipment creation error:", shipmentError);
      return json({ error: "Failed to create shipment" }, { status: 500 });
    }

    return json({ success: true, data: result });
  } catch (error) {
    console.error("Create shipment error:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};