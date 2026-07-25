import { data as json, type ActionFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import {
  checkDeleteUsageLimit,
  recordDeleteUsage,
} from "~/lib/usageGateway.server";

/**
 * Delete shipment for authenticated shop only (shop_id + si_number).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  const messages = {
    siNumberRequired: ja ? "SI番号が必須です" : "SI number is required",
    shipmentNotFound: ja
      ? "指定されたSI番号のデータが見つかりません"
      : "No shipment found for the specified SI number",
    databaseError: ja ? "データベースエラーが発生しました" : "A database error occurred",
    deleteFailed: ja ? "データの削除に失敗しました" : "Failed to delete data",
    serverError: ja
      ? "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。"
      : "A server error occurred. Please try again later.",
    success: ja ? "データを正常に削除しました" : "Data deleted successfully",
    authFailed: ja ? "認証に失敗しました" : "Authentication failed",
  };

  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json({ error: messages.authFailed }, { status: auth.status });
  }
  const shopId = auth.shop;

  try {
    const formData = await request.formData();
    const siNumber = (formData.get("siNumber") as string) || "";

    if (!siNumber) {
      return json({ error: messages.siNumberRequired }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: existingShipment, error: checkError } = await supabase
      .from("shipments")
      .select("si_number, shop_id")
      .eq("si_number", siNumber)
      .eq("shop_id", shopId)
      .maybeSingle();

    if (checkError) {
      return json({ error: messages.databaseError }, { status: 500 });
    }

    if (!existingShipment) {
      return json({ error: messages.shipmentNotFound }, { status: 404 });
    }

    try {
      await checkDeleteUsageLimit(shopId, 2);
    } catch {
      return json({ error: "DELETE_LIMIT_EXCEEDED" }, { status: 403 });
    }

    const { error: deleteError } = await supabase
      .from("shipments")
      .delete()
      .eq("si_number", siNumber)
      .eq("shop_id", shopId);

    if (deleteError) {
      return json({ error: messages.deleteFailed }, { status: 500 });
    }

    try {
      await recordDeleteUsage({ shopId });
    } catch {
      // count failure must not undo delete
    }

    return json({ success: true, message: messages.success });
  } catch {
    return json({ error: messages.serverError }, { status: 500 });
  }
};
