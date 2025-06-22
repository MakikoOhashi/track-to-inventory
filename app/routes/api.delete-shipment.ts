import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { authenticate } from "~/shopify.server";
import { checkDeleteLimit, incrementDeleteCount } from "~/lib/redis.server";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const action = async ({ request }: any) => {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // 1. Shopify認証を実行
    const { session } = await authenticate.admin(request);
    const shopId = session.shop;

    const formData = await request.formData();
    const siNumber = formData.get("siNumber") as string;

    if (!siNumber) {
      return json({ error: "SI番号が必須です" }, { status: 400 });
    }

    // 2. 削除対象の存在チェック
    const { data: existingShipment, error: checkError } = await supabase
      .from("shipments")
      .select("si_number, shop_id")
      .eq("si_number", siNumber)
      .eq("shop_id", shopId)
      .single();

    if (checkError || !existingShipment) {
      return json({ error: "指定されたSI番号のデータが見つかりません" }, { status: 404 });
    }

    // 3. 削除回数制限チェック（削除前に実行）
    try {
      await checkDeleteLimit(shopId, 2); // 2回まで
    } catch (limitError) {
      console.error("Delete limit error:", limitError);
      return json({ 
        error: "Freeプランの削除可能回数を超えました。プランをアップグレードしてください。" 
      }, { status: 403 });
    }

    // 4. 実際の削除処理
    const { error: deleteError } = await supabase
      .from("shipments")
      .delete()
      .eq("si_number", siNumber)
      .eq("shop_id", shopId);

    if (deleteError) {
      console.error("Delete error:", deleteError);
      return json({ error: "データの削除に失敗しました" }, { status: 500 });
    }

    // 5. 削除成功後に回数をカウント
    await incrementDeleteCount(shopId);

    return json({ success: true, message: "データを正常に削除しました" });
  } catch (error) {
    console.error("Delete shipment error:", error);
    return json({ 
      error: "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。" 
    }, { status: 500 });
  }
};