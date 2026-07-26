import { data as json, type ActionFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import {
  checkDeleteUsageLimit,
  recordDeleteUsage,
} from "~/lib/usageGateway.server";
import {
  scheduleShipmentsShadowTask,
  shadowCompareGetAfterRead,
  shadowWriteShipmentMirror,
} from "~/lib/d1ShipmentsShadow.server";
import {
  executeDeleteShipmentFlow,
  type DeleteShipmentPrimaryGateway,
} from "~/lib/deleteShipmentFlow.server";

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
    databaseError: ja
      ? "データベースエラーが発生しました"
      : "A database error occurred",
    deleteFailed: ja ? "データの削除に失敗しました" : "Failed to delete data",
    serverError: ja
      ? "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。"
      : "A server error occurred. Please try again later.",
    success: ja ? "データを正常に削除しました" : "Data deleted successfully",
    authFailed: ja ? "認証に失敗しました" : "Authentication failed",
  };

  const result = await executeDeleteShipmentFlow({
    request,
    messages,
    dependencies: {
      requireAdminShop,
      createPrimaryGateway(): DeleteShipmentPrimaryGateway {
        const supabase = createSupabaseAdminClient();
        return {
          async find(shopId, siNumber) {
            return supabase
              .from("shipments")
              .select("*")
              .eq("si_number", siNumber)
              .eq("shop_id", shopId)
              .maybeSingle();
          },
          async delete(shopId, siNumber) {
            return supabase
              .from("shipments")
              .delete()
              .eq("si_number", siNumber)
              .eq("shop_id", shopId);
          },
        };
      },
      checkDeleteUsageLimit,
      recordDeleteUsage,
      scheduleShadowTask: scheduleShipmentsShadowTask,
      compareShadowRead: shadowCompareGetAfterRead,
      deleteShadow: shadowWriteShipmentMirror,
    },
  });

  return json(result.body, { status: result.status });
};
