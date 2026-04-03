import { redirect } from "react-router";
import { getCurrentPlan } from "~/lib/shopifyBilling.server";
import { authenticate } from "~/shopify.server";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await getCurrentPlan(session);
  return redirect("/app/pricing");
};
