import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { authenticate } from "~/shopify.server";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: any) => {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // Shopify認証を実行（fallback処理付き）
    let shopId: string;
  try {
      const { session } = await authenticate.admin(request);
      shopId = session.shop;
    } catch (authError) {
      // Fallback: URLパラメータからshop情報を取得
      const url = new URL(request.url);
      const shopParam = url.searchParams.get('shop');
      
      if (shopParam) {
        shopId = shopParam;
      } else {
        return json({ 
          error: "認証に失敗しました。アプリを再インストールしてください。" 
        }, { status: 401 });
  }
    }

    const formData = await request.formData();
    const siNumber = formData.get("siNumber") as string;
    const fileType = formData.get("fileType") as string;

    if (!siNumber || !fileType) {
      return json({ error: "SI番号とファイルタイプが必須です" }, { status: 400 });
  }

    // ファイルパスを構築
    const filePath = `${siNumber}/${fileType}`;

    // Supabase Storageからファイルを削除
    const { error: storageError } = await supabase.storage
    .from("shipment-files")
    .remove([filePath]);

    if (storageError) {
      console.error("Storage delete error:", storageError);
      return json({ error: "ファイルの削除に失敗しました" }, { status: 500 });
    }

    // データベースからファイルURLを削除
    const updateData: any = {
      si_number: siNumber,
      shop_id: shopId,
    };

    // ファイルタイプに応じてURLをnullに設定
    switch (fileType) {
      case "invoice":
        updateData.invoice_url = null;
        break;
      case "pl":
        updateData.pl_url = null;
        break;
      case "si":
        updateData.si_url = null;
        break;
      case "other":
        updateData.other_url = null;
        break;
      default:
        return json({ error: "無効なファイルタイプです" }, { status: 400 });
    }

    const { error: dbError } = await supabase
      .from("shipments")
      .upsert(updateData, {
        onConflict: "si_number,shop_id",
      });

    if (dbError) {
      console.error("Database update error:", dbError);
      return json({ error: "データベースの更新に失敗しました" }, { status: 500 });
  }

    return json({ success: true, message: "ファイルを正常に削除しました" });
  } catch (error) {
    console.error("Delete file error:", error);
    return json({ 
      error: "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。" 
    }, { status: 500 });
  }
};