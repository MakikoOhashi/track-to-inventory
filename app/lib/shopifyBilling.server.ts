import { redis, UserPlan } from "./redis.server";
import { GraphqlClient, Session } from "@shopify/shopify-api";

const planNameMap: Record<string, UserPlan> = {
  "Basic Plan": "basic",
  "Pro Plan": "pro",
};

type ActiveSubscriptionsData = {
  currentAppInstallation: {
    activeSubscriptions: { name: string; status: string }[];
  };
};

type ActiveSubscriptionsResponse = {
  data: ActiveSubscriptionsData;
};

export async function getCurrentPlan(session: Session): Promise<UserPlan> {
  const skipBilling = process.env.DISABLE_BILLING === "true";

  if (skipBilling) {
    return (await redis.get<UserPlan>(`plan:${session.shop}`)) ?? "free";
  }

  // sessionの整合性チェック
  if (!session || !session.shop || !session.accessToken) {
    console.error("Invalid session:", session);
    throw new Error("Invalid Shopify session");
  }

  // scopeが設定されていない場合は環境変数から取得してsessionに追加
  if (!session.scope) {
    (session as any).scope = process.env.SCOPES || "";
  }

  const client = new GraphqlClient({ session });

  const query = `
    {
      currentAppInstallation {
        activeSubscriptions {
          name
          status
        }
      }
    }
  `;

  const response = await client.query<ActiveSubscriptionsResponse>({ data: query });

  const subs = response.body?.data?.currentAppInstallation?.activeSubscriptions;
  if (!Array.isArray(subs)) {
    throw new Error("Shopify Billing APIのレスポンスが不正です");
  }

  // Pro優先→Basic→Free
  if (subs.some((s: any) => planNameMap[s.name] === "pro" && s.status === "ACTIVE")) {
    await redis.set(`plan:${session.shop}`, "pro");
    return "pro";
  }
  if (subs.some((s: any) => planNameMap[s.name] === "basic" && s.status === "ACTIVE")) {
    await redis.set(`plan:${session.shop}`, "basic");
    return "basic";
  }
  await redis.set(`plan:${session.shop}`, "free");
  return "free";
}