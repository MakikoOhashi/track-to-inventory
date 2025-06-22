import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: any) => {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const siNumber = formData.get("siNumber") as string;
    const shopId = formData.get("shopId") as string;
    const fileType = formData.get("fileType") as string;

    if (!siNumber || !shopId || !fileType) {
      return json({ error: "Missing required fields" }, { status: 400 });
    }

    // ファイルパスを構築
    const filePath = `${siNumber}/${fileType}`;

    // Supabase Storageからファイルを削除
    const { error: storageError } = await supabase.storage
      .from("shipment-files")
      .remove([filePath]);

    if (storageError) {
      console.error("Storage delete error:", storageError);
      return json({ error: "Failed to delete file from storage" }, { status: 500 });
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
        return json({ error: "Invalid file type" }, { status: 400 });
    }

    const { error: dbError } = await supabase
      .from("shipments")
      .upsert(updateData, {
        onConflict: "si_number,shop_id",
      });

    if (dbError) {
      console.error("Database update error:", dbError);
      return json({ error: "Failed to update database" }, { status: 500 });
    }

    return json({ success: true });
  } catch (error) {
    console.error("Delete file error:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};