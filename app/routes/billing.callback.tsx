import { redirect } from "@remix-run/node";
import { getCurrentPlan } from "~/lib/shopifyBilling.server";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await getCurrentPlan(session.shop, session.accessToken);
  return redirect("/app/pricing");
}; 