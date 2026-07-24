import { data as json, type LoaderFunctionArgs } from "react-router";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

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
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("shipments")
      .select("*")
      .eq("shop_id", auth.shop);

    if (error) {
      return json(
        { error: ja ? "データベースエラーが発生しました" : "Database error" },
        { status: 500 },
      );
    }

    return json({ shipments: data || [], shop: auth.shop });
  } catch {
    return json(
      { error: ja ? "認証に失敗しました" : "Authentication failed" },
      { status: 401 },
    );
  }
};
