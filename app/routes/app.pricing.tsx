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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

const plans = [
  {
    key: "free",
    name: "無料プラン",
    price: "¥0",
    description: "基本機能が無料！",
    features: [
      "最大2件のSI登録（同時保有）",
      "月2回までのSI削除",
      "月5回のOCR利用",
      "各ファイル最大10MB・最大4枚（計40MB）",
      "Shopify在庫連携なし",
      "サポートなし",
      "AI利用：月5回まで",
    ],
    button: (
      <Button disabled fullWidth>
        現在のプラン
      </Button>
    ),
    highlight: false,
    badge: (
      <Badge tone="success">
        現在のプラン
      </Badge>
    ),
  },
  {
    key: "basic",
    name: "ベーシックプラン",
    price: "¥980",
    description: "追加機能とサポートがご利用いただけます。",
    features: [
      "最大20件のSI登録（同時保有）",
      "SI削除：無制限",
      "月50回のOCR利用",
      "各ファイル最大10MB・最大4枚（計40MB）",
      "Shopify在庫連携あり",
      "通常サポート",
      "AI利用：月50回まで",
    ],
    button: (
      <Button url="https://your-billing-link/basic" fullWidth variant="primary">
        プランを選択
      </Button>
    ),
    highlight: false,
  },
  {
    key: "pro",
    name: "プロプラン",
    price: "¥2,980",
    description: "すべての機能と優先サポートがご利用いただけます。",
    features: [
      "SI登録：無制限",
      "SI削除：無制限",
      "OCR利用：無制限",
      "各ファイル最大10MB・最大4枚（計40MB）※使用状況に応じ制限の可能性あり",
      "Shopify在庫連携あり",
      "優先サポート",
      "AI利用：無制限（※過剰使用時は制限の可能性あり）",
    ],
    button: (
      <Button url="https://your-billing-link/pro" fullWidth variant="primary">
        プランを選択
      </Button>
    ),
    highlight: true,
    badge: (
      <div style={{ backgroundColor: "#6e38f7", color: "white", padding: "4px 8px", borderRadius: "4px", fontSize: "12px", fontWeight: "500" }}>
        最も人気のある
      </div>
    ),
  },
];

export default function Pricing() {
  return (
    <Page title="サブスクリプションプラン">
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
                          /月
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
              プランと機能を比較
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
                        機能
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
                        無料
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
                        ベーシック
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
                        プロ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["割引バリアントの制限", "100", "20", "無制限"],
                      ["ボリュームディスカウントの階層", "1", "5", "無制限"],
                      ["カート値に基づく割引階層（カート目標）", "1", "5", "無制限"],
                      ["SI登録件数（同時保有）", "2", "20", "無制限"],
                      ["SI削除回数（月）", "2回", "無制限", "無制限"],
                      ["OCR回数", "5回", "50回", "無制限"],
                      ["AI利用回数", "5回", "50回", "無制限"],
                      ["Shopify在庫連携", "×", "○", "○"],
                      ["サポート", "なし", "通常", "優先"],
                      ["ファイル保存容量", "1件あたり最大10MB×4枚", "1件あたり最大10MB×4枚", "1件あたり最大10MB×4枚※使用状況に応じ制限の可能性あり"],
                    ].map((row, i) => (
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