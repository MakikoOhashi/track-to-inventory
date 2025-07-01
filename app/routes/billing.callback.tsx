import { redirect } from "@remix-run/node";
import { getCurrentPlan } from "~/lib/shopifyBilling.server";
import { authenticate } from "~/shopify.server";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await getCurrentPlan(session);
  return redirect("/app/pricing");
};