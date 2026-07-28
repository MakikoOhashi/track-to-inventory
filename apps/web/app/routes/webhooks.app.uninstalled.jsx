import { authenticate } from "~/shopify.server";
import { cleanupUninstall } from "~/lib/uninstallCleanup.server";

export const action = async ({ request }) => {
  const { shop } = await authenticate.webhook(request);
  await cleanupUninstall(shop);
  return new Response();
};
