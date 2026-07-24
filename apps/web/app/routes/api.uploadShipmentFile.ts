import { data as json, type ActionFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import {
  getShipmentFileStorage,
  ShipmentFileStorageError,
} from "~/lib/shipmentFileStorage.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

/**
 * Upload a shipment-related file to Storage (Workers → Supabase; no Render).
 * Shop is taken only from authenticate.admin session.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const ja = isJapaneseRequest(request, resolveRequestLocale(request));

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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json(
      { error: ja ? "必須フィールドが不足しています" : "Required fields are missing" },
      { status: 400 },
    );
  }

  const siNumber = formData.get("si_number");
  const type = formData.get("type");
  const file = formData.get("file");

  if (typeof siNumber !== "string" || typeof type !== "string" || !(file instanceof File)) {
    return json(
      { error: ja ? "必須フィールドが不足しています" : "Required fields are missing" },
      { status: 400 },
    );
  }

  try {
    const result = await getShipmentFileStorage().uploadShipmentFile({
      siNumber,
      type,
      file,
      shop: auth.shop,
    });
    return json(result);
  } catch (error) {
    if (error instanceof ShipmentFileStorageError) {
      const message =
        error.status === 404
          ? ja
            ? "出荷データが見つかりません"
            : "Shipment not found"
          : error.status === 403
            ? ja
              ? "アクセス権限がありません"
              : "Access denied"
            : error.message;
      return json({ error: message }, { status: error.status });
    }

    return json(
      {
        error: ja
          ? "ファイルアップロード中にエラーが発生しました"
          : "An error occurred while uploading the file",
      },
      { status: 500 },
    );
  }
};
