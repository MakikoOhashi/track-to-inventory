import { data as json, type LoaderFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { shipmentsReadGateway } from "~/lib/d1ShipmentsReadGateway.server";
import {
  scheduleShipmentsShadowTask,
  shadowCompareListAfterRead,
} from "~/lib/d1ShipmentsShadow.server";

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
    const result = await shipmentsReadGateway.list(auth.shop);
    const shipments = result.data;
    if (result.source === "supabase") {
      scheduleShipmentsShadowTask(() =>
        shadowCompareListAfterRead({
          shopId: auth.shop,
          primaryRows: shipments,
        }),
      );
    }
    return json({ shipments, shop: auth.shop });
  } catch {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: 401 },
    );
  }
};
