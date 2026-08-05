import type { Session } from "@shopify/shopify-api";
import { GraphqlClient } from "@shopify/shopify-api";
import type { UserPlan } from "~/lib/d1/planLimits.server";
import { getPlanViaGateway, persistUserPlan } from "./usageGateway.server";

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
    try {
      return await getPlanViaGateway(session.shop);
    } catch {
      return "free";
    }
  }

  try {
    if (!session || !session.shop || !session.accessToken) {
      throw new Error("Invalid Shopify session");
    }

    if (!session.scope) {
      (session as any).scope = process.env.SCOPES || "";
    }

    const client = new GraphqlClient({
      session,
      apiVersion: "2024-01" as any,
    });

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
    let plan: UserPlan = "free";
    if (Array.isArray(subs)) {
      if (subs.some((s: any) => planNameMap[s.name] === "pro" && s.status === "ACTIVE")) {
        plan = "pro";
      } else if (subs.some((s: any) => planNameMap[s.name] === "basic" && s.status === "ACTIVE")) {
        plan = "basic";
      }
    }

    await persistUserPlan(session.shop, plan, "shopify_billing");
    return plan;
  } catch {
    return "free";
  }
}
