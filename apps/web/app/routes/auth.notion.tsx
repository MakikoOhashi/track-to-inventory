import { redirect, type LoaderFunctionArgs } from "react-router";
import {
  saveNotionOAuthState,
} from "~/lib/notionConnection.server";
import {
  buildNotionAuthorizeUrl,
  createNotionOAuthState,
  isNotionOAuthConfigured,
} from "~/lib/notionOAuth.server";
import { isTokenEncryptionConfigured } from "~/lib/tokenEncryption.server";
import { requireAdminShop } from "~/lib/requireAdminShop.server";

/**
 * Start Notion OAuth for the authenticated Shopify shop.
 * Session shop is the only tenant identity (query shop ignored for binding).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await requireAdminShop(request);
  if (!auth.ok) {
    return new Response("Unauthorized", { status: auth.status });
  }

  if (!isNotionOAuthConfigured() || !isTokenEncryptionConfigured()) {
    return new Response(
      "Notion OAuth is not configured (NOTION_CLIENT_ID/SECRET/REDIRECT_URI and TOKEN_ENCRYPTION_KEY)",
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const returnPath = url.searchParams.get("return") || "/app/notion";

  const state = createNotionOAuthState(auth.shop);
  await saveNotionOAuthState(state, {
    shop: auth.shop,
    created_at: new Date().toISOString(),
    return_path: returnPath.startsWith("/app") ? returnPath : "/app/notion",
  });

  return redirect(buildNotionAuthorizeUrl(state));
};
