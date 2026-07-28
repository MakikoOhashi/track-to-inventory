import { data as json, type ActionFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createShipmentsRepository, ShipmentDuplicateError } from "~/lib/d1/shipments.server";

/**
 * Update shipment for authenticated shop only.
 * Uses UPDATE on (shop_id, si_number) — never SI-only, never body shop_id auth.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: auth.status },
    );
  }
  const shopId = auth.shop;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: ja ? "JSONが不正です" : "Invalid JSON" }, { status: 400 });
  }

  const { shipment } = body;
  if (!shipment) {
    return json(
      { error: ja ? "配送データがありません" : "Missing shipment data" },
      { status: 400 },
    );
  }

  if (!shipment.si_number || typeof shipment.si_number !== "string") {
    return json(
      { error: ja ? "si_numberが必要です" : "si_number is required" },
      { status: 400 },
    );
  }
  const siNumber = shipment.si_number.trim();

  const {
    invoiceFile,
    siFile,
    plFile,
    otherFile,
    created_at,
    updated_at,
    id,
    shop_id: _ignoredShop,
    ...safeData
  } = shipment;

  const cleanDateField = (value: any) => {
    if (value === "" || value === undefined) return null;
    return value;
  };

  const cleanedData = {
    ...safeData,
    si_number: siNumber,
    shop_id: shopId,
    eta: cleanDateField(safeData.eta),
    etd: cleanDateField(safeData.etd),
    clearance_date: cleanDateField(safeData.clearance_date),
    arrival_date: cleanDateField(safeData.arrival_date),
  };

  try {
    const db = getOptionalTtiDb();
    if (!db) throw new Error("TTI_DB binding missing");
    let updated;
    try {
      updated = await createShipmentsRepository(db).update(shopId, siNumber, cleanedData);
    } catch (error) {
      if (error instanceof ShipmentDuplicateError) {
        return json({ error: ja ? "このSI番号は既に登録されています" : "This SI number is already registered" }, { status: 409 });
      }
      throw error;
    }
    if (!updated) {
      return json(
        { error: ja ? "出荷データが見つかりません" : "Shipment not found" },
        { status: 404 },
      );
    }

    return json({ data: [updated] });
  } catch {
    return json(
      {
        error: ja
          ? "データベース操作に失敗しました"
          : "Database operation failed",
      },
      { status: 500 },
    );
  }
};
