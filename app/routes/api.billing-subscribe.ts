import { json, redirect } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getCurrentPlan } from "~/lib/shopifyBilling.server";
import { GraphqlClient, Session } from "@shopify/shopify-api";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { plan: planKey } = await request.json();

  // 既存プラン確認
  const currentPlan = await getCurrentPlan(session.shop, session.accessToken);
  if (currentPlan === planKey) {
    return json({ alreadyActive: true });
  }

  // プランごとの設定
  const planConfig = {
    basic: {
      name: "Basic Plan",
      price: { amount: 9.99, currencyCode: "USD" },
    },
    pro: {
      name: "Pro Plan",
      price: { amount: 29.99, currencyCode: "USD" },
    },
  }[planKey];

  if (!planConfig) return json({ error: "Invalid plan" }, { status: 400 });

  // GraphQL mutation
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

  const client = new GraphqlClient({ session });
  const response = await client.query({ data: mutation });
  const confirmationUrl = response.body.data.appSubscriptionCreate.confirmationUrl;

  // hostパラメータを付与してリダイレクト
  return redirect(`${confirmationUrl}&host=${session.host}`);
}; 