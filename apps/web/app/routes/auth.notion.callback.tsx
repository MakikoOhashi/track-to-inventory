import { redirect, type LoaderFunctionArgs } from "react-router";
import {
  consumeNotionOAuthState,
  upsertNotionConnectionFromOAuth,
} from "~/lib/notionConnection.server";
import {
  exchangeNotionCode,
  parseAndVerifyNotionOAuthState,
} from "~/lib/notionOAuth.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * Notion OAuth callback. Tenant is taken only from signed+Redis state, never from query shop.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const fail = (reason: string) =>
    redirect(`/app/notion?notion_error=${encodeURIComponent(reason)}`);

  if (error) {
    return fail(error === "access_denied" ? "oauth_denied" : `oauth_${error}`);
  }
  if (!code || !state) {
    return fail("missing_code_or_state");
  }

  const parsed = parseAndVerifyNotionOAuthState(state);
  if (!parsed) {
    return fail("invalid_state");
  }

  const stored = await consumeNotionOAuthState(state);
  if (!stored) {
    return fail("state_expired");
  }

  const shopFromState = normalizeShopDomain(parsed.shopId);
  const shopFromRedis = normalizeShopDomain(stored.shop);
  if (!shopFromState || !shopFromRedis || shopFromState !== shopFromRedis) {
    return fail("shop_mismatch");
  }

  try {
    const token = await exchangeNotionCode(code);
    await upsertNotionConnectionFromOAuth({
      shop: shopFromState,
      accessToken: token.access_token,
      workspaceId: token.workspace_id ?? null,
      workspaceName: token.workspace_name ?? null,
      botId: token.bot_id ?? null,
    });
  } catch {
    // Do not echo Notion/token error details to the client URL
    return fail("token_exchange_failed");
  }

  const returnPath = stored.return_path || "/app/notion";
  return redirect(`${returnPath}?notion=connected`);
};
