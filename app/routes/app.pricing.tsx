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

// カスタムクラスでスタイルを調整
const cardHighlightStyle: React.CSSProperties = {
  border: "2px solid #6e38f7",
  boxShadow: "0 0 0 3px #ede8fd",
  position: "relative",
  minHeight: 520,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  width: 340,
};
const cardDefaultStyle: React.CSSProperties = {
  border: "1px solid #e0e0e0",
  boxShadow: "0 1px 3px #f6f6f6",
  position: "relative",
  minHeight: 520,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  width: 340,
};

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
      <Badge /* toneなしでデフォルト */>
        最も人気のある
      </Badge>
    ),
  },
];

export default function Pricing() {
  return (
    <Page title="サブスクリプションプラン">
      <Box paddingBlockStart="400" paddingBlockEnd="400">
        {/* プランカード（横並び・横スクロール不要UI） */}
        <div
          style={{
            display: "flex",
            gap: "24px",
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {plans.map((plan) => (
            <div
              key={plan.key}
              style={plan.highlight ? cardHighlightStyle : cardDefaultStyle}
            >
              <Card padding="0">
                {/* バッジ */}
                {plan.badge && (
                  <div style={{
                    position: "absolute",
                    top: 18,
                    left: "50%",
                    transform: "translateX(-50%)"
                  }}>
                    {plan.badge}
                  </div>
                )}
                <Box
                  paddingBlockStart="400"
                  paddingBlockEnd="400"
                  paddingInlineStart="400"
                  paddingInlineEnd="400"
                >
                  <Text as="h3" variant="headingMd" alignment="center">
                    {plan.name}
                  </Text>
                  <Box paddingBlockStart="100">
                    <Text
                      as="p"
                      variant="headingLg"
                      alignment="center"
                      fontWeight="bold"
                    >
                      {plan.price}
                    </Text>
                  </Box>
                  <Box paddingBlockStart="100">
                    <Text
                      as="p"
                      alignment="center"
                      tone="subdued"
                    >
                      {plan.description}
                    </Text>
                  </Box>
                  <ul style={{ marginTop: 28, marginBottom: 0, paddingLeft: 20, fontSize: 14 }}>
                    {plan.features.map((feature, i) => (
                      <li key={i}>{feature}</li>
                    ))}
                  </ul>
                </Box>
                <Box padding="400">{plan.button}</Box>
              </Card>
            </div>
          ))}
        </div>
      </Box>

      {/* 機能比較表 */}
      <Box paddingBlockStart="400" paddingBlockEnd="400">
        <Card>
          <Box padding="400">
            <Text as="h2" variant="headingMd">
              プランと機能を比較
            </Text>
            <table style={{ width: "100%", marginTop: 24, borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ padding: 8, borderBottom: "1px solid #ccc", background: "#f9f9f9", textAlign: "left" }}>機能</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #ccc", background: "#f9f9f9" }}>無料</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #ccc", background: "#f9f9f9" }}>ベーシック</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #ccc", background: "#f9f9f9" }}>プロ</th>
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
                  ["ファイル保存容量", "最大10MB×4枚", "最大10MB×4枚", "最大10MB×4枚（※制限の可能性あり）"],
                ].map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{row[0]}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "center" }}>{row[1]}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "center" }}>{row[2]}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "center" }}>{row[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
        </Card>
      </Box>
    </Page>
  );
}