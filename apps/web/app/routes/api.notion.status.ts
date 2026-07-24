import { data as json, type LoaderFunctionArgs } from "react-router";
import {
  getNotionConnection,
  toPublicNotionConnection,
} from "~/lib/notionConnection.server";
import { isNotionOAuthConfigured } from "~/lib/notionOAuth.server";
import { requireAdminShop } from "~/lib/requireAdminShop.server";
import { isTokenEncryptionConfigured } from "~/lib/tokenEncryption.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return json({ error: "Unauthorized" }, { status: auth.status });
  }

  // Ignore any body/query shop_id — session shop only
  const conn = await getNotionConnection(auth.shop);
  return json({
    shop: auth.shop,
    oauthConfigured: isNotionOAuthConfigured() && isTokenEncryptionConfigured(),
    connection: toPublicNotionConnection(conn),
  });
};
