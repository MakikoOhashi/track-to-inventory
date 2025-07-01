import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Badge,
  Button,
  Box,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { getCurrentPlan } from "~/lib/shopifyBilling.server";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const plan = await getCurrentPlan(session);
  return json({ plan });
};

export default function Pricing() {
  const { plan } = useLoaderData<typeof loader>();
  const { t, i18n } = useTranslation("common");

  // プラン選択時のAPI呼び出し
  const handlePlanSelect = async (planKey: string) => {
    const res = await fetch("/api/billing-subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: planKey }),
    });
    if (res.redirected) {
      window.location.href = res.url;
    } else {
      const data = await res.json();
      if (data.alreadyActive) {
        alert("すでにこのプランが有効です");
      } else if (data.error) {
        alert(data.error);
      }
    }
  };

  const plans = [
    {
      key: "free",
      name: t("plan.free.name"),
      price: t("plan.free.price"),
      description: t("plan.free.description"),
      button: (
        <Button disabled={plan === "free"} fullWidth>
          {plan === "free" ? t("plan.free.current") : t("plan.free.select")}
        </Button>
      ),
    },
    {
      key: "basic",
      name: t("plan.basic.name"),
      price: t("plan.basic.price"),
      description: t("plan.basic.description"),
      button: (
        <Button
          onClick={() => handlePlanSelect("basic")}
          disabled={plan === "basic"}
          fullWidth
          variant="primary"
        >
          {plan === "basic" ? t("plan.basic.current") : t("plan.basic.select")}
        </Button>
      ),
    },
    {
      key: "pro",
      name: t("plan.pro.name"),
      price: t("plan.pro.price"),
      description: t("plan.pro.description"),
      button: (
        <Button
          onClick={() => handlePlanSelect("pro")}
          disabled={plan === "pro"}
          fullWidth
          variant="primary"
        >
          {plan === "pro" ? t("plan.pro.current") : t("plan.pro.select")}
        </Button>
      ),
    },
  ];

  const comparisonRows = [
    [t("pricing.comparison.siCount"), "2", "20", t("pricing.comparison.unlimited")],
    [t("pricing.comparison.siDelete"), "2" + t("pricing.comparison.times"), t("pricing.comparison.unlimited"), t("pricing.comparison.unlimited")],
    [t("pricing.comparison.ocrCount"), "5" + t("pricing.comparison.times"), "50" + t("pricing.comparison.times"), t("pricing.comparison.unlimited")],
    [t("pricing.comparison.aiCount"), "5" + t("pricing.comparison.times"), "50" + t("pricing.comparison.times"), t("pricing.comparison.unlimited")],
    [t("pricing.comparison.shopifySync"), t("pricing.comparison.no"), t("pricing.comparison.yes"), t("pricing.comparison.yes")],
    [t("pricing.comparison.support"), t("pricing.comparison.none"), t("pricing.comparison.normal"), t("pricing.comparison.priority")],
    [t("pricing.comparison.fileCapacity"), t("pricing.comparison.fileCapacityValue"), t("pricing.comparison.fileCapacityValue"), t("pricing.comparison.fileCapacityValuePro")],
  ];

  return (
    <Page title={t("pricing.title")}>
      <Box paddingBlockEnd="200">
        <div style={{ maxWidth: 200 }}>
          <LanguageSwitcher value={i18n.language} onChange={i18n.changeLanguage} />
        </div>
      </Box>
      <Box paddingBlockStart="400" paddingBlockEnd="400">
        {/* プランカード - レスポンシブGrid */}
        <style>
          {`
            .pricing-grid {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 24px;
              max-width: 1200px;
              margin: 0 auto;
              padding: 0 16px;
            }
            @media (max-width: 1024px) {
              .pricing-grid {
                grid-template-columns: repeat(2, 1fr);
              }
            }
            @media (max-width: 640px) {
              .pricing-grid {
                grid-template-columns: 1fr;
              }
            }
          `}
        </style>
        <div className="pricing-grid">
          {plans.map((plan) => (
            <Card key={plan.key}>
              <Text as="h3">{plan.name}</Text>
              <Text as="p">{plan.price}</Text>
              <Text as="p">{plan.description}</Text>
              {plan.button}
            </Card>
          ))}
        </div>
      </Box>

      {/* 機能比較表 */}
      <Box paddingBlockStart="600" paddingBlockEnd="400">
        <Card>
          <Box padding="400">
            <Text as="h2" variant="headingLg">
              {t("pricing.comparison.title")}
            </Text>
            <Box paddingBlockStart="400">
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    minWidth: "700px",
                    borderCollapse: "collapse",
                    fontSize: "14px",
                    backgroundColor: "#ffffff",
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        style={{
                          padding: "16px 12px",
                          borderBottom: "2px solid #e1e1e1",
                          backgroundColor: "#f9fafb",
                          textAlign: "left",
                          fontWeight: "600",
                          color: "#202223",
                        }}
                      >
                        {t("pricing.comparison.feature")}
                      </th>
                      <th
                        style={{
                          padding: "16px 12px",
                          borderBottom: "2px solid #e1e1e1",
                          backgroundColor: "#f9fafb",
                          textAlign: "center",
                          fontWeight: "600",
                          color: "#202223",
                          minWidth: "100px",
                        }}
                      >
                        {t("plan.free.name")}
                      </th>
                      <th
                        style={{
                          padding: "16px 12px",
                          borderBottom: "2px solid #e1e1e1",
                          backgroundColor: "#f9fafb",
                          textAlign: "center",
                          fontWeight: "600",
                          color: "#202223",
                          minWidth: "120px",
                        }}
                      >
                        {t("plan.basic.name")}
                      </th>
                      <th
                        style={{
                          padding: "16px 12px",
                          borderBottom: "2px solid #e1e1e1",
                          backgroundColor: "#f9fafb",
                          textAlign: "center",
                          fontWeight: "600",
                          color: "#202223",
                          minWidth: "100px",
                        }}
                      >
                        {t("plan.pro.name")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRows.map((row, i) => (
                      <tr
                        key={i}
                        style={{
                          backgroundColor: i % 2 === 0 ? "#ffffff" : "#fafbfc",
                        }}
                      >
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: "1px solid #e1e1e1",
                            color: "#202223",
                            fontWeight: "500",
                          }}
                        >
                          {row[0]}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: "1px solid #e1e1e1",
                            textAlign: "center",
                            color: "#6d7175",
                          }}
                        >
                          {row[1]}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: "1px solid #e1e1e1",
                            textAlign: "center",
                            color: "#6d7175",
                          }}
                        >
                          {row[2]}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: "1px solid #e1e1e1",
                            textAlign: "center",
                            color: "#6d7175",
                            fontWeight: "600",
                          }}
                        >
                          {row[3]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Box>
          </Box>
        </Card>
      </Box>
    </Page>
  );
}