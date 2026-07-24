import { data as json, type ActionFunctionArgs } from "react-router";
import { checkSILimit } from "~/lib/redis.server";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

type ShipmentItem = {
  name: string;
  quantity: number | string;
  product_code?: string;
  unit_price?: string;
};

/**
 * Create shipment for the authenticated shop only.
 * Body/query shop_id is ignored for authorization.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: auth.status },
    );
  }
  const shopId = auth.shop;

  try {
    const contentType = request.headers.get("content-type");
    let siNumber: string;
    let supplierName: string;
    let transportType: string;
    let items: ShipmentItem[];
    let invoiceUrl: string | null;
    let plUrl: string | null;
    let siUrl: string | null;
    let otherUrl: string | null;

    if (contentType?.includes("application/json")) {
      const body = await request.json();
      const shipment = body.shipment;
      if (!shipment) {
        return json(
          { error: ja ? "配送データが必要です" : "Shipment data is required" },
          { status: 400 },
        );
      }
      const { created_at, updated_at, id, ...cleanShipment } = shipment;
      siNumber = cleanShipment.si_number;
      supplierName = cleanShipment.supplier_name;
      transportType = cleanShipment.transport_type;
      items = cleanShipment.items || [];
      invoiceUrl = cleanShipment.invoice_url ?? null;
      plUrl = cleanShipment.pl_url ?? null;
      siUrl = cleanShipment.si_url ?? null;
      otherUrl = cleanShipment.other_url ?? null;
    } else if (
      contentType?.includes("multipart/form-data") ||
      contentType?.includes("application/x-www-form-urlencoded")
    ) {
      const formData = await request.formData();
      siNumber = formData.get("siNumber") as string;
      supplierName = formData.get("supplierName") as string;
      transportType = formData.get("transportType") as string;
      const itemsStr = formData.get("items") as string;
      items = itemsStr ? JSON.parse(itemsStr) : [];
      invoiceUrl = (formData.get("invoiceUrl") as string) || null;
      plUrl = (formData.get("plUrl") as string) || null;
      siUrl = (formData.get("siUrl") as string) || null;
      otherUrl = (formData.get("otherUrl") as string) || null;
    } else {
      return json(
        { error: ja ? "未対応のContent-Typeです" : "Unsupported content type" },
        { status: 400 },
      );
    }

    if (!siNumber || typeof siNumber !== "string" || !siNumber.trim()) {
      return json(
        { error: ja ? "必須フィールドが不足しています" : "Required fields are missing" },
        { status: 400 },
      );
    }
    siNumber = siNumber.trim();

    const supabase = createSupabaseAdminClient();
    const { data: existingShipment, error: checkError } = await supabase
      .from("shipments")
      .select("si_number")
      .eq("si_number", siNumber)
      .eq("shop_id", shopId)
      .maybeSingle();

    if (checkError) {
      return json(
        { error: ja ? "データベースエラーが発生しました" : "Database error" },
        { status: 500 },
      );
    }

    if (existingShipment) {
      return json(
        {
          error: ja
            ? "このSI番号は既に登録されています"
            : "This SI number is already registered",
        },
        { status: 409 },
      );
    }

    try {
      await checkSILimit(shopId);
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : ja
                ? "SI登録件数の上限に達しました"
                : "SI registration limit reached",
        },
        { status: 403 },
      );
    }

    const shipmentData = {
      si_number: siNumber,
      shop_id: shopId,
      supplier_name: supplierName || null,
      transport_type: transportType || null,
      items: items || [],
      status: "SI発行済",
      invoice_url: invoiceUrl || null,
      pl_url: plUrl || null,
      si_url: siUrl || null,
      other_url: otherUrl || null,
      delayed: false,
      is_archived: false,
    };

    const { data: result, error: shipmentError } = await supabase
      .from("shipments")
      .insert([shipmentData])
      .select()
      .single();

    if (shipmentError) {
      if (shipmentError.code === "23505") {
        return json(
          {
            error: ja
              ? "このSI番号は既に登録されています"
              : "This SI number is already registered",
          },
          { status: 409 },
        );
      }
      return json(
        {
          error: ja ? "データの保存に失敗しました" : "Failed to save data",
          details: shipmentError.message,
        },
        { status: 500 },
      );
    }

    return json({
      success: true,
      data: result,
      message: ja ? "SIが正常に登録されました" : "SI was registered successfully",
    });
  } catch (error) {
    return json(
      {
        error: ja ? "内部サーバーエラーが発生しました" : "Internal server error",
        details:
          error instanceof Error
            ? error.message
            : error instanceof Response
              ? `HTTP ${error.status}`
              : String(error),
      },
      { status: 500 },
    );
  }
};
