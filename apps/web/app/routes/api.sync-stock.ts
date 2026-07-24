import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { listLedgerForShipment } from "~/lib/syncLedger.server";
import { SyncStockError, syncShipmentStock } from "~/lib/syncStock.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * Stage I: re-run-safe DELTA sync with inventory_sync_ledger + Shopify @idempotent.
 * Shop is taken only from authenticate.admin session.
 *
 * GET ?siNumber= — read-only ledger rows for investigation (no secrets).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  let shop: string;
  try {
    const auth = await authenticate.admin(request);
    shop = normalizeShopDomain(auth.session.shop);
    if (!shop) {
      return json(
        { error: ja ? "認証に失敗しました" : "Authentication failed" },
        { status: 401 },
      );
    }
  } catch {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const siNumber = url.searchParams.get("siNumber") || url.searchParams.get("si_number") || "";
  if (!siNumber) {
    return json(
      { error: ja ? "SI番号が必要です" : "SI number is required" },
      { status: 400 },
    );
  }

  try {
    const rows = await listLedgerForShipment({ shopId: shop, siNumber });
    return json({ shop, si_number: siNumber, ledger: rows });
  } catch {
    return json(
      { error: ja ? "ledgerの取得に失敗しました" : "Failed to load ledger" },
      { status: 500 },
    );
  }
};

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
      items: items as Array<{
        sync_item_id?: string;
        variant_id?: string;
        quantity?: unknown;
      }>,
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
