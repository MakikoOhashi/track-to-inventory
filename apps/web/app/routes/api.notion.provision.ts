import { data as json, type ActionFunctionArgs } from "react-router";
import { provisionShipmentsDatabase } from "~/lib/notionProvision.server";
import { requireAdminShop } from "~/lib/requireAdminShop.server";

/**
 * Explicit user-initiated Shipments DB provision. Never auto-runs on install.
 * Body shop_id is ignored.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json({ error: "Unauthorized" }, { status: auth.status });
  }

  let parentPageId: string | null = null;
  let allowAddMissingProperties = true;
  try {
    const body = (await request.json()) as {
      parent_page_id?: unknown;
      shop_id?: unknown;
      allow_add_missing_properties?: unknown;
    };
    // Explicitly ignore body.shop_id
    void body.shop_id;
    if (typeof body.parent_page_id === "string" && body.parent_page_id.trim()) {
      parentPageId = body.parent_page_id.trim();
    }
    if (typeof body.allow_add_missing_properties === "boolean") {
      allowAddMissingProperties = body.allow_add_missing_properties;
    }
  } catch {
    // empty body is fine
  }

  const result = await provisionShipmentsDatabase({
    shopId: auth.shop,
    parentPageId,
    allowAddMissingProperties,
  });

  if (!result.ok) {
    const status =
      result.code === "NOT_CONNECTED" || result.code === "MISSING_PARENT"
        ? 400
        : result.code === "LOCK_BUSY"
          ? 409
          : result.code === "DUPLICATE_DATABASES" || result.code === "SCHEMA_MISMATCH"
            ? 409
            : 502;
    return json(result, { status });
  }

  return json({ shop: auth.shop, ...result });
};
