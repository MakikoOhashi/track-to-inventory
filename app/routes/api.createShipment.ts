import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { checkSILimit } from "~/lib/redis.server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
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
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const shipment: Shipment = body.shipment;


// バリデーション
if (!shipment?.si_number || !shipment?.supplier_name) {
  return json({ error: "SI番号と仕入先は必須項目です" }, { status: 400 });
}

// ★★★ ここでSI登録件数制限チェックを追加 ★★★
try {
  if (shipment?.shop_id) {
    await checkSILimit(shipment.shop_id); // shopIdで判定
  } else {
    return json({ error: "shop_idが必要です" }, { status: 400 });
  }
} catch (error) {
  if (error instanceof Error) {
    return json({ error: error.message || "SI登録件数の上限に達しました" }, { status: 403 });
  }
  return json({ error: "SI登録件数の上限に達しました" }, { status: 403 });
}
// データ保存
const { data: shipmentData, error: shipmentError } = await supabase
  .from("shipments")
  .insert([
    {
      ...shipment,
      status: shipment.status || "SI発行済",
      delayed: shipment.delayed ?? false,
      is_archived: shipment.is_archived ?? false,
    },
  ])
  .select()
  .single();



  if (shipmentError) {
    return json(
      {
        error: "データの保存に失敗しました",
        details: shipmentError.message,
        hint: shipmentError.hint,
      },
      { status: 500 }
    );
  }

  return json({
    id: shipmentData.id,
    message: "データが正常に保存されました",
    data: shipmentData,
  });
};