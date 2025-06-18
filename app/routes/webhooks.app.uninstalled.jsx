import { authenticate } from "../shopify.server";
import { createClient } from "@supabase/supabase-js";
import db from "../db.server";

// Supabaseクライアント初期化
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Service Role Keyを必ず使う
);

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Shopifyセッション削除
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Supabase shipmentsテーブルからshop_idで削除
  if (shop) {
    const { error } = await supabase
      .from("shipments")
      .delete()
      .eq("shop_id", shop);

    if (error) {
      console.error("Supabase shipments削除エラー:", error);
    }
  }

  return new Response();
};