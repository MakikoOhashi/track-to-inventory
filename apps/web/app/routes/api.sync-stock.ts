import { data as json, type ActionFunctionArgs } from "react-router";
import { SyncStockError, syncShipmentStock } from "~/lib/syncStock.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * Stage G: sync stock on Workers (no Render).
 * Shop is taken only from authenticate.admin session.
 *
 * Inventory update mode (unchanged from Render): DELTA adjust via
 * inventoryAdjustQuantities; fallback set to current+delta.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"];
  let shop: string;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
    shop = normalizeShopDomain(auth.session.shop);
    if (!shop) {
      return json(
        { error: ja ? "認証に失敗しました" : "Authentication failed" },
        { status: 401 },
      );
    }
  } catch (error) {
    if (error instanceof Response) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 401;
      return json(
        { error: ja ? "認証に失敗しました" : "Authentication failed" },
        { status: status === 403 ? 403 : 401 },
      );
    }
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(
      { error: ja ? "リクエスト形式が不正です" : "Invalid request body" },
      { status: 400 },
    );
  }

  const items = body.items;
  const siNumber =
    typeof body.siNumber === "string"
      ? body.siNumber
      : typeof body.si_number === "string"
        ? body.si_number
        : "";

  if (!Array.isArray(items) || items.length === 0) {
    return json(
      { error: ja ? "同期する商品がありません" : "No items to sync" },
      { status: 400 },
    );
  }

  if (!siNumber) {
    return json(
      { error: ja ? "SI番号が必要です" : "SI number is required" },
      { status: 400 },
    );
  }

  try {
    const result = await syncShipmentStock({
      admin,
      shop,
      siNumber,
      items: items as Array<{ variant_id?: string; quantity?: unknown }>,
    });
    return json(result);
  } catch (error) {
    if (error instanceof SyncStockError) {
      const message =
        error.code === "NOT_FOUND"
          ? ja
            ? "出荷データが見つかりません"
            : "Shipment not found"
          : error.code === "FORBIDDEN_ITEM"
            ? ja
              ? "同期対象の商品が不正です"
              : "Invalid sync item"
            : error.message;
      return json({ error: message }, { status: error.status });
    }

    return json(
      { error: ja ? "在庫同期に失敗しました" : "Stock sync failed" },
      { status: 500 },
    );
  }
};
