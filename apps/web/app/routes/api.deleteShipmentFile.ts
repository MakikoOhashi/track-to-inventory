import { data as json } from "react-router";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

function isJapaneseRequest(request: Request) {
  const acceptLanguage = request.headers.get("accept-language") || "";
  return acceptLanguage.toLowerCase().includes("ja");
}

function getMessages(request: Request) {
  const url = new URL(request.url);
  const locale = (url.searchParams.get("locale") || request.headers.get("x-app-locale") || "").toLowerCase();
  const ja = locale.startsWith("ja") || (!locale && isJapaneseRequest(request));
  return {
    methodNotAllowed: ja ? "Method not allowed" : "Method not allowed",
    shopIdRequired: ja ? "shop_idが必要です" : "shop_id is required",
    invalidParams: ja ? "SI番号とファイルタイプが必須です" : "SI number and file type are required",
    fileDeleteFailed: ja ? "ファイルの削除に失敗しました" : "Failed to delete file",
    invalidFileType: ja ? "無効なファイルタイプです" : "Invalid file type",
    dbUpdateFailed: ja ? "データベースの更新に失敗しました" : "Failed to update database",
    serverError: ja
      ? "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。"
      : "A server error occurred. Please try again later.",
    success: ja ? "ファイルを正常に削除しました" : "File deleted successfully",
  };
}

export const action = async ({ request }: any) => {
  const messages = getMessages(request);
  if (request.method !== "DELETE") {
    return json({ error: messages.methodNotAllowed }, { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const body = await request.formData().catch(async () => {
      const jsonBody = await request.json().catch(() => ({}));
      return jsonBody;
    });
    const formLocale = (body.get?.("locale") as string | null)?.toLowerCase() || (body.locale as string | undefined)?.toLowerCase() || "";
    const requestLocale = (url.searchParams.get("locale") || request.headers.get("x-app-locale") || formLocale || "").toLowerCase();
    const ja = requestLocale.startsWith("ja") || (!requestLocale && isJapaneseRequest(request));
    const messages = {
      methodNotAllowed: ja ? "Method not allowed" : "Method not allowed",
      shopIdRequired: ja ? "shop_idが必要です" : "shop_id is required",
      invalidParams: ja ? "SI番号とファイルタイプが必須です" : "SI number and file type are required",
      fileDeleteFailed: ja ? "ファイルの削除に失敗しました" : "Failed to delete file",
      invalidFileType: ja ? "無効なファイルタイプです" : "Invalid file type",
      dbUpdateFailed: ja ? "データベースの更新に失敗しました" : "Failed to update database",
      serverError: ja
        ? "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。"
        : "A server error occurred. Please try again later.",
      success: ja ? "ファイルを正常に削除しました" : "File deleted successfully",
    };

    const shopId =
      url.searchParams.get("shop_id") ||
      url.searchParams.get("shop") ||
      body.get?.("shop_id") ||
      body.get?.("shopId") ||
      body.shop_id ||
      body.shopId ||
      "";

    if (!shopId) {
      return json({
        error: messages.shopIdRequired
      }, { status: 401 });
    }

    const siNumber = body.get?.("siNumber") as string || body.siNumber;
    const fileType = body.get?.("fileType") as string || body.fileType;

    if (!siNumber || !fileType) {
      return json({ error: messages.invalidParams }, { status: 400 });
  }

    // ファイルパスを構築
    const filePath = `${siNumber}/${fileType}`;

    // Supabase Storageからファイルを削除
    const { error: storageError } = await supabase.storage
    .from("shipment-files")
    .remove([filePath]);

    if (storageError) {
      return json({ error: messages.fileDeleteFailed }, { status: 500 });
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
        return json({ error: messages.invalidFileType }, { status: 400 });
    }

    const { error: dbError } = await supabase
      .from("shipments")
      .upsert(updateData, {
        onConflict: "si_number,shop_id",
      });

    if (dbError) {
      return json({ error: messages.dbUpdateFailed }, { status: 500 });
  }

    return json({ success: true, message: messages.success });
  } catch (error) {
    return json({ 
      error: getMessages(request).serverError
    }, { status: 500 });
  }
};
