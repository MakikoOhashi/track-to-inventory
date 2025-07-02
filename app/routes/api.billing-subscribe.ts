import { json, redirect } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import type { ActionFunctionArgs } from "@remix-run/node";

const planConfigs = {
  basic: {
    name: "Basic Plan",
    price: { amount: 9.99, currencyCode: "USD" },
  },
  pro: {
    name: "Pro Plan",
    price: { amount: 29.99, currencyCode: "USD" },
  },
} as const;

type PlanKey = keyof typeof planConfigs;

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const { plan: planKey } = await request.json();
    const planConfig = planConfigs[planKey as PlanKey];
    if (!planConfig) return json({ error: "Invalid plan" }, { status: 400 });

    // 1. 現在のプランを取得
    const statusRes = await admin.graphql(`
      {
        currentAppInstallation {
          activeSubscriptions {
            name
            status
          }
        }
      }
    `);
    const statusJson = await statusRes.json();
    const subs = statusJson?.data?.currentAppInstallation?.activeSubscriptions || [];
    if (subs.some((s: any) => s.name === planConfig.name && s.status === "ACTIVE")) {
      return json({ alreadyActive: true });
    }

    // 2. サブスクリプション作成
    const mutation = `
      mutation appSubscriptionCreate {
        appSubscriptionCreate(
          name: \"${planConfig.name}\",
          returnUrl: \"${process.env.APP_URL}/billing/callback?shop=${session.shop}\",
          test: true,
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: ${planConfig.price.amount}, currencyCode: ${planConfig.price.currencyCode} }
              }
            }
          }]
        ) {
          confirmationUrl
          userErrors { field, message }
        }
      }
    `;
    const mutationRes = await admin.graphql(mutation);
    const mutationJson = await mutationRes.json();
    // Shopify GraphQLの標準エラー配列を詳細に出力
    const mutationJsonAny = mutationJson as any;
    if (Array.isArray(mutationJsonAny.errors) && mutationJsonAny.errors.length > 0) {
      console.error("GraphQL error details (errors):", mutationJsonAny.errors);
    }
    // 念のため全体も出力
    if (!mutationJsonAny.data || !mutationJsonAny.data.appSubscriptionCreate) {
      console.error("GraphQL mutation response (full):", mutationJsonAny);
    }
    const subscriptionData = mutationJsonAny?.data?.appSubscriptionCreate;
    if (!subscriptionData) {
      return json({ error: "Invalid response from Shopify" }, { status: 500 });
    }
    if (subscriptionData.userErrors && subscriptionData.userErrors.length > 0) {
      console.error("GraphQL error details (userErrors):", subscriptionData.userErrors);
      const errorMessages = subscriptionData.userErrors.map((err: any) => err.message).join(", ");
      return json({ error: `Subscription creation failed: ${errorMessages}` }, { status: 400 });
    }
    const confirmationUrl = subscriptionData.confirmationUrl;
    if (!confirmationUrl) {
      return json({ error: "Failed to create subscription - no confirmation URL" }, { status: 500 });
    }
    // session.hostを使用
    const host = (session as any).host;
    if (!host) {
      return json({ error: "Missing host parameter in session" }, { status: 400 });
    }
    return redirect(`${confirmationUrl}&host=${encodeURIComponent(host)}`);
  } catch (error) {
    console.error("Billing subscription error:", error);
    return json({ error: "Failed to process subscription request" }, { status: 500 });
  }
};