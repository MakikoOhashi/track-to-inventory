import { data as json } from "react-router";
import { createClient } from "@supabase/supabase-js";
import { checkDeleteLimit, incrementDeleteCount } from "~/lib/redis.server";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function isJapaneseRequest(request: Request) {
  const acceptLanguage = request.headers.get("accept-language") || "";
  return acceptLanguage.toLowerCase().includes("ja");
}

function getDeleteMessages(request: Request) {
  const url = new URL(request.url);
  const locale = (url.searchParams.get("locale") || request.headers.get("x-app-locale") || "").toLowerCase();
  const ja = locale.startsWith("ja") || (!locale && isJapaneseRequest(request));
  return {
    shopIdRequired: ja ? "shop_idが必要です" : "shop_id is required",
    siNumberRequired: ja ? "SI番号が必須です" : "SI number is required",
    shipmentNotFound: ja ? "指定されたSI番号のデータが見つかりません" : "No shipment found for the specified SI number",
    databaseError: ja ? "データベースエラーが発生しました" : "A database error occurred",
    deleteFailed: ja ? "データの削除に失敗しました" : "Failed to delete data",
    serverError:
      ja
        ? "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。"
        : "A server error occurred. Please try again later.",
    success: ja ? "データを正常に削除しました" : "Data deleted successfully",
  };
}

export const action = async ({ request }: any) => {
  const messages = getDeleteMessages(request);

  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const formData = await request.formData();
    const formLocale = (formData.get("locale") as string | null)?.toLowerCase() || "";
    const messages = (() => {
      const requestLocale = (url.searchParams.get("locale") || request.headers.get("x-app-locale") || formLocale || "").toLowerCase();
      const ja = requestLocale.startsWith("ja") || (!requestLocale && isJapaneseRequest(request));
      return {
        shopIdRequired: ja ? "shop_idが必要です" : "shop_id is required",
        siNumberRequired: ja ? "SI番号が必須です" : "SI number is required",
        shipmentNotFound: ja ? "指定されたSI番号のデータが見つかりません" : "No shipment found for the specified SI number",
        databaseError: ja ? "データベースエラーが発生しました" : "A database error occurred",
        deleteFailed: ja ? "データの削除に失敗しました" : "Failed to delete data",
        serverError:
          ja
            ? "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。"
            : "A server error occurred. Please try again later.",
        success: ja ? "データを正常に削除しました" : "Data deleted successfully",
      };
    })();
    const shopId =
      url.searchParams.get("shop_id") ||
      url.searchParams.get("shop") ||
      (formData.get("shop_id") as string) ||
      (formData.get("shopId") as string) ||
      "";

    if (!shopId) {
      return json({
        error: messages.shopIdRequired
      }, { status: 401 });
    }

    const siNumber = formData.get("siNumber") as string;

    if (!siNumber) {
      return json({ error: messages.siNumberRequired }, { status: 400 });
    }

    // 2. 削除対象の存在チェック
    const { data: existingShipment, error: checkError } = await supabase
      .from("shipments")
      .select("si_number, shop_id")
      .eq("si_number", siNumber)
      .eq("shop_id", shopId)
      .single();

    if (checkError) {
      if (checkError.code === 'PGRST116') {
        return json({ error: messages.shipmentNotFound }, { status: 404 });
      }
      return json({ error: messages.databaseError }, { status: 500 });
    }

    if (!existingShipment) {
      return json({ error: messages.shipmentNotFound }, { status: 404 });
    }

    // 3. 削除回数制限チェック（削除前に実行）
    try {
      await checkDeleteLimit(shopId, 2); // 2回まで
    } catch (limitError) {
      return json({ 
        error: "DELETE_LIMIT_EXCEEDED"
      }, { status: 403 });
    }

    // 4. 実際の削除処理
    const { error: deleteError } = await supabase
      .from("shipments")
      .delete()
      .eq("si_number", siNumber)
      .eq("shop_id", shopId);

    if (deleteError) {
      return json({ error: messages.deleteFailed }, { status: 500 });
    }

    // 5. 削除成功後に回数をカウント
    try {
      await incrementDeleteCount(shopId);
    } catch (countError) {
      // カウントエラーは削除処理を妨げない
    }
    return json({ success: true, message: messages.success });
  } catch (error) {
    return json({ 
      error: getDeleteMessages(request).serverError
    }, { status: 500 });
  }
};
