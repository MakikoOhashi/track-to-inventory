import { data as json, type ActionFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createShipmentsRepository } from "~/lib/d1/shipments.server";
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

  if (request.method !== "DELETE") return json({ error: "Method not allowed" }, { status: 405 });
  const auth = await requireAdminShop(request);
  if (!auth.ok) return json({ error: messages.authFailed }, { status: auth.status });
  const formData = await request.formData();
  const siNumber = String(formData.get("siNumber") || "").trim();
  if (!siNumber) return json({ error: messages.siNumberRequired }, { status: 400 });
  const db = getOptionalTtiDb();
  if (!db) return json({ error: messages.databaseError }, { status: 500 });
  const repo = createShipmentsRepository(db);
  if (!(await repo.getByShopAndSi(auth.shop, siNumber)) ) return json({ error: messages.shipmentNotFound }, { status: 404 });
  try { await checkDeleteUsageLimit(auth.shop, 2); } catch { return json({ error: "DELETE_LIMIT_EXCEEDED" }, { status: 403 }); }
  if (!(await repo.delete(auth.shop, siNumber))) return json({ error: messages.deleteFailed }, { status: 500 });
  try { await recordDeleteUsage({ shopId: auth.shop }); } catch { /* deletion remains successful */ }
  return json({ success: true, message: messages.success });
};
