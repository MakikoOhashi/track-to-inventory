import { data as json, type ActionFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import {
  getShipmentFileStorage,
  ShipmentFileStorageError,
} from "~/lib/shipmentFileStorage.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

/**
 * Issue signed Storage URLs for shipment files (Workers → Supabase; no Render).
 * Shop is taken only from authenticate.admin session.
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(
      { error: ja ? "ファイルパスが指定されていません" : "File path is required" },
      { status: 400 },
    );
  }

  const siNumber = typeof body.siNumber === "string" ? body.siNumber : "";
  const filePaths = body.filePaths;

  try {
    const result = await getShipmentFileStorage().createSignedFileUrls({
      filePaths: filePaths as string | string[],
      siNumber,
      shop: auth.shop,
    });
    return json(result);
  } catch (error) {
    if (error instanceof ShipmentFileStorageError) {
      const message =
        error.code === "NOT_FOUND"
          ? ja
            ? "ファイルが見つかりません"
            : "File not found"
          : error.code === "NO_PATHS"
            ? ja
              ? "ファイルパスが指定されていません"
              : "File path is required"
            : error.code === "SI_REQUIRED"
              ? ja
                ? "SI番号が必要です"
                : "SI number is required"
              : error.message;
      return json({ error: message }, { status: error.status });
    }

    return json(
      { error: ja ? "署名付きURLの生成に失敗しました" : "Failed to generate signed URLs" },
      { status: 500 },
    );
  }
};
