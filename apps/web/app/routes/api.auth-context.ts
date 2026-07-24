import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * Stage B+C auth probe.
 * Shop is taken only from authenticate.admin (session token), never from query/body.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const shop = normalizeShopDomain(session.shop);

    if (!shop) {
      return json({ ok: false }, { status: 401 });
    }

    return json({
      ok: true,
      shop,
    });
  } catch (error) {
    if (error instanceof Response) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 401;
      // Prefer a stable JSON 401 for API clients instead of HTML bounce/redirect bodies.
      if (status === 401 || status === 403) {
        return json({ ok: false }, { status });
      }
      return json({ ok: false }, { status: 401 });
    }

    return json({ ok: false }, { status: 401 });
  }
}
