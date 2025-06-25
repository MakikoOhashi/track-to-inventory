import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Page,
  Card,
  Text,
  Badge,
  Button,
  Box,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Pricing() {
  const { t, i18n } = useTranslation("common");
  const plans = [
    {
      key: "free",
      name: t("plan.free.name"),
      price: t("plan.free.price"),
      description: t("plan.free.description"),
      features: [
        t("plan.free.feature1"),
        t("plan.free.feature2"),
        t("plan.free.feature3"),
        t("plan.free.feature4"),
        t("plan.free.feature5"),
        t("plan.free.feature6"),
        t("plan.free.feature7"),
      ],
      button: (
        <Button disabled fullWidth>
          {t("plan.free.current")}
        </Button>
      ),
      highlight: false,
      badge: null,
    },
    {
      key: "basic",
      name: t("plan.basic.name"),
      price: t("plan.basic.price"),
      description: t("plan.basic.description"),
      features: [
        t("plan.basic.feature1"),
        t("plan.basic.feature2"),
        t("plan.basic.feature3"),
        t("plan.basic.feature4"),
        t("plan.basic.feature5"),
        t("plan.basic.feature6"),
        t("plan.basic.feature7"),
      ],
      button: (
        <Button url="https://your-billing-link/basic" fullWidth variant="primary">
          {t("plan.basic.select")}
        </Button>
      ),
      highlight: true,
      badge: (
        <div style={{ backgroundColor: "#00a047", color: "white", padding: "4px 8px", borderRadius: "4px", fontSize: "12px", fontWeight: "500" }}>
          {t("plan.basic.badge")}
        </div>
      ),
    },
    {
      key: "pro",
      name: t("plan.pro.name"),
      price: t("plan.pro.price"),
      description: t("plan.pro.description"),
      features: [
        t("plan.pro.feature1"),
        t("plan.pro.feature2"),
        t("plan.pro.feature3"),
        t("plan.pro.feature4"),
        t("plan.pro.feature5"),
        t("plan.pro.feature6"),
        t("plan.pro.feature7"),
      ],
      button: (
        <Button url="https://your-billing-link/pro" fullWidth variant="primary">
          {t("plan.pro.select")}
        </Button>
      ),
      highlight: true,
      badge: (
        <div style={{ backgroundColor: "#6e38f7", color: "white", padding: "4px 8px", borderRadius: "4px", fontSize: "12px", fontWeight: "500" }}>
          {t("plan.pro.badge")}
        </div>
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
        <LanguageSwitcher value={i18n.language} onChange={i18n.changeLanguage} />
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
            <div key={plan.key} style={{ position: "relative" }}>
              {/* バッジ */}
              {plan.badge && (
                <div
                  style={{
                    position: "absolute",
                    top: "-12px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 10,
                  }}
                >
                  {plan.badge}
                </div>
              )}

              <Card 
                padding="0"
                background="bg-surface"
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    minHeight: "500px",
                  }}
                >
                  {/* ヘッダー部分 */}
                  <Box paddingBlockStart="600" paddingBlockEnd="400" paddingInline="400">
                    <div style={{ textAlign: "center" }}>
                      <Text as="h3" variant="headingMd">
                        {plan.name}
                      </Text>
                      <Box paddingBlockStart="200">
                        <Text as="p" variant="headingXl" fontWeight="bold">
                          {plan.price}
                        </Text>
                        <Text as="span" variant="bodyMd" tone="subdued">
                          {t("pricing.perMonth")}
                        </Text>
                      </Box>
                      <Box paddingBlockStart="100">
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {plan.description}
                        </Text>
                      </Box>
                    </div>
                  </Box>

                  {/* 機能リスト */}
                  <div style={{ flex: 1, padding: "0 24px" }}>
                    <ul
                      style={{
                        listStyle: "none",
                        padding: 0,
                        margin: 0,
                        fontSize: "14px",
                        lineHeight: "1.6",
                      }}
                    >
                      {plan.features.map((feature, i) => (
                        <li
                          key={i}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            marginBottom: "12px",
                            paddingLeft: "24px",
                            position: "relative",
                          }}
                        >
                          <span
                            style={{
                              position: "absolute",
                              left: "0",
                              top: "6px",
                              width: "16px",
                              height: "16px",
                              borderRadius: "50%",
                              backgroundColor: plan.highlight ? "#6e38f7" : "#00a047",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "10px",
                              color: "white",
                              flexShrink: 0,
                            }}
                          >
                            ✓
                          </span>
                          <span style={{ color: "#202223" }}>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* ボタン */}
                  <Box padding="400">
                    {plan.button}
                  </Box>
                </div>
                </Card>
            </div>
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