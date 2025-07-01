import { json, redirect } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getCurrentPlan } from "~/lib/shopifyBilling.server";
import { GraphqlClient } from "@shopify/shopify-api";

import type { ActionFunctionArgs } from "@remix-run/node";

// GraphQL レスポンスの型定義
type AppSubscriptionCreateResponse = {
  data: {
    appSubscriptionCreate: {
      confirmationUrl?: string;
      userErrors: Array<{
        field: string;
        message: string;
      }>;
    };
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { plan: planKey } = await request.json();

  // 既存プラン確認（getCurrentPlanの呼び出しを修正）
  const currentPlan = await getCurrentPlan(session);
  if (currentPlan === planKey) {
    return json({ alreadyActive: true });
  }

  // プランごとの設定
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

  const planConfig = planConfigs[planKey as PlanKey];

  if (!planConfig) return json({ error: "Invalid plan" }, { status: 400 });

  // GraphQL mutation
  const mutation = `
    mutation appSubscriptionCreate {
      appSubscriptionCreate(
        name: "${planConfig.name}",
        returnUrl: "${process.env.APP_URL}/billing/callback?shop=${session.shop}",
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
  
  try {
    // 型アサーションを使用してレスポンスの型を指定
    const response = await client.query<AppSubscriptionCreateResponse>({ data: mutation });

    // エラーハンドリングの改善
    const subscriptionData = response.body?.data?.appSubscriptionCreate;
    
    if (!subscriptionData) {
      return json({ error: "Invalid response from Shopify" }, { status: 500 });
    }

    // userErrorsをチェック
    if (subscriptionData.userErrors && subscriptionData.userErrors.length > 0) {
      const errorMessages = subscriptionData.userErrors.map(err => err.message).join(", ");
      return json({ error: `Subscription creation failed: ${errorMessages}` }, { status: 400 });
    }

    const confirmationUrl = subscriptionData.confirmationUrl;
    if (!confirmationUrl) {
      return json({ error: "Failed to create subscription - no confirmation URL" }, { status: 500 });
    }

    // hostパラメータを取得
    const url = new URL(request.url);
    const host = url.searchParams.get("host");
    if (!host) {
      return json({ error: "Missing host parameter" }, { status: 400 });
    }

    // hostパラメータを付与してリダイレクト
    return redirect(`${confirmationUrl}&host=${encodeURIComponent(host)}`);
    
  } catch (error) {
    console.error("Billing subscription error:", error);
    return json({ error: "Failed to process subscription request" }, { status: 500 });
  }
};