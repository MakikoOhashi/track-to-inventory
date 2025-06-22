import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { checkDeleteLimit, incrementDeleteCount } from "~/lib/redis.server"; // あなたの環境に合わせて

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const action = async ({ request }: any) => {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const siNumber = formData.get("siNumber") as string;
    const shopId = formData.get("shopId") as string;

    if (!siNumber || !shopId) {
      return json({ error: "Missing required fields" }, { status: 400 });
    }

    const { error } = await supabase
      .from("shipments")
      .delete()
      .eq("si_number", siNumber)
      .eq("shop_id", shopId);

    if (error) {
      console.error("Delete error:", error);
      return json({ error: "Failed to delete shipment" }, { status: 500 });
    }

    // 削除回数チェック（エラーが発生した場合は例外を投げる）
    try {
      await checkDeleteLimit(shopId, 2); // 2回まで
      // 削除回数カウント
      await incrementDeleteCount(shopId);
    } catch (limitError) {
      console.error("Delete limit error:", limitError);
      return json({ error: "Freeプランの削除可能回数を超えました" }, { status: 403 });
    }

    return json({ success: true });
  } catch (error) {
    console.error("Delete shipment error:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};