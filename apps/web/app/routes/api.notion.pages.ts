import { data as json, type LoaderFunctionArgs } from "react-router";
import { listNotionParentPages } from "~/lib/notionProvision.server";
import { requireAdminShop } from "~/lib/requireAdminShop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json({ error: "Unauthorized" }, { status: auth.status });
  }

  const result = await listNotionParentPages(auth.shop);
  if (!result.ok) {
    return json(
      { error: result.message, code: result.code },
      { status: result.code === "NOT_CONNECTED" ? 400 : 502 },
    );
  }

  return json({ shop: auth.shop, pages: result.pages });
};
