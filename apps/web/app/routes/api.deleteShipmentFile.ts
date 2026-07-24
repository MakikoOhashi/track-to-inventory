import { data as json, type ActionFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import {
  ALLOWED_SHIPMENT_FILE_TYPES,
  SHIPMENT_FILES_BUCKET,
  buildLegacyShipmentFilePath,
  buildShopScopedShipmentFilePath,
  resolveStorageObjectPath,
} from "~/lib/shipmentFileStorage.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

const COMMON_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt"] as const;

/**
 * Delete a shipment file from Storage + clear DB column.
 * Shop comes only from authenticate.admin. Removes shop-scoped objects and
 * uniquely referenced legacy keys when present.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: auth.status },
    );
  }

  let body: FormData | Record<string, unknown>;
  try {
    body = await request.formData();
  } catch {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }

  const getField = (key: string) => {
    if (body instanceof FormData) {
      const value = body.get(key);
      return typeof value === "string" ? value : "";
    }
    const value = body[key];
    return typeof value === "string" ? value : "";
  };

  const siNumber = getField("siNumber");
  const fileType = getField("fileType");

  if (!siNumber || !fileType) {
    return json(
      {
        error: ja
          ? "SI番号とファイルタイプが必須です"
          : "SI number and file type are required",
      },
      { status: 400 },
    );
  }

  if (!(ALLOWED_SHIPMENT_FILE_TYPES as readonly string[]).includes(fileType)) {
    return json(
      { error: ja ? "無効なファイルタイプです" : "Invalid file type" },
      { status: 400 },
    );
  }

  const supabase = createSupabaseAdminClient();
  const { data: shipment, error: loadError } = await supabase
    .from("shipments")
    .select("invoice_url, pl_url, si_url, other_url")
    .eq("si_number", siNumber)
    .eq("shop_id", auth.shop)
    .maybeSingle();

  if (loadError) {
    return json(
      { error: ja ? "データベースの更新に失敗しました" : "Failed to update database" },
      { status: 500 },
    );
  }

  if (!shipment) {
    return json(
      { error: ja ? "出荷データが見つかりません" : "Shipment not found" },
      { status: 404 },
    );
  }

  const columnKey = `${fileType}_url` as "invoice_url" | "pl_url" | "si_url" | "other_url";
  const dbPath = resolveStorageObjectPath(shipment[columnKey] || "");

  const candidates = new Set<string>();
  if (dbPath) candidates.add(dbPath);

  for (const ext of COMMON_EXTS) {
    candidates.add(buildShopScopedShipmentFilePath(auth.shop, siNumber, fileType, ext));
    candidates.add(buildLegacyShipmentFilePath(siNumber, fileType, ext));
  }

  const { error: storageError } = await supabase.storage
    .from(SHIPMENT_FILES_BUCKET)
    .remove([...candidates]);

  if (storageError) {
    return json(
      { error: ja ? "ファイルの削除に失敗しました" : "Failed to delete file" },
      { status: 500 },
    );
  }

  const updateData: Record<string, string | null> = {
    si_number: siNumber,
    shop_id: auth.shop,
    [columnKey]: null,
  };

  const { error: dbError } = await supabase.from("shipments").upsert(updateData, {
    onConflict: "si_number,shop_id",
  });

  if (dbError) {
    return json(
      { error: ja ? "データベースの更新に失敗しました" : "Failed to update database" },
      { status: 500 },
    );
  }

  return json({
    success: true,
    message: ja ? "ファイルを正常に削除しました" : "File deleted successfully",
  });
};
