import { json, type ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { checkDeleteLimit, incrementDeleteCount } from "~/lib/redis.server"; // あなたの環境に合わせて

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, { status: 405 });
  const { shop_id, shipment_id, plan } = await request.json();

  // 削除回数チェック
  try {
    if (plan === "Free") {
      await checkDeleteLimit(shop_id, 2); // 2回まで
    }
    // 他プランは無制限
  } catch (e) {
    return json({ error: "Freeプランの削除可能回数を超えました" }, { status: 403 });
  }

  // 削除
  const { error } = await supabase.from("shipments").delete().eq("id", shipment_id);
  if (error) return json({ error: "削除に失敗しました", details: error.message }, { status: 500 });

  // 削除回数カウント
  if (plan === "Free") await incrementDeleteCount(shop_id);

  return json({ success: true });
};