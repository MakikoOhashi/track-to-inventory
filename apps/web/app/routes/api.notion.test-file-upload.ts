import { data as json, type ActionFunctionArgs } from "react-router";
import { runNotionFileUploadSmoke } from "~/lib/notionFileUpload.server";
import { requireAdminShop } from "~/lib/requireAdminShop.server";

/**
 * Isolated Notion File Upload smoke test. Does not mutate Supabase shipments/Storage
 * and never triggers Shopify inventory mutations.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json({ error: "Unauthorized" }, { status: auth.status });
  }

  // Ignore any spoofed shop_id in body
  try {
    const body = (await request.json()) as { shop_id?: unknown };
    void body.shop_id;
  } catch {
    // optional body
  }

  const result = await runNotionFileUploadSmoke(auth.shop);
  if (!result.ok) {
    const status =
      result.code === "NOT_CONNECTED" || result.code === "NOT_PROVISIONED"
        ? 400
        : 502;
    return json(result, { status });
  }

  return json({ shop: auth.shop, ...result });
};
