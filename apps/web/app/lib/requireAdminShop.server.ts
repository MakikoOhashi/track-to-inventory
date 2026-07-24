import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * Resolve the authenticated shop from a Bearer session token.
 * Never trusts query/body shop values.
 */
export async function requireAdminShop(request: Request): Promise<
  | { ok: true; shop: string }
  | { ok: false; status: 401 | 403 }
> {
  try {
    const auth = await authenticate.admin(request);
    const shop = normalizeShopDomain(auth.session.shop);
    if (!shop) {
      return { ok: false, status: 401 };
    }
    return { ok: true, shop };
  } catch (error) {
    if (error instanceof Response) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 401;
      return { ok: false, status: status === 403 ? 403 : 401 };
    }
    return { ok: false, status: 401 };
  }
}
