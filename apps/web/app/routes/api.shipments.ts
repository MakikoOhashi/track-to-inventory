import { data as json, type LoaderFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import { createShipmentsRepository } from "~/lib/d1/shipments.server";

/**
 * List shipments for the authenticated shop only.
 * Query shop_id is ignored for authorization.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: auth.status },
    );
  }

  try {
    const db = getOptionalTtiDb();
    if (!db) throw new Error("TTI_DB binding missing");
    const shipments = await createShipmentsRepository(db).listByShop(auth.shop);
    return json({ shipments, shop: auth.shop });
  } catch {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: 401 },
    );
  }
};
