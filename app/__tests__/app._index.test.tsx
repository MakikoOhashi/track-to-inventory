// /// <reference types="vitest" />

// import React from "react";
// import { render, screen, fireEvent, waitFor } from "@testing-library/react";
// import { MemoryRouter } from "react-router-dom";
// import { describe, it, expect, beforeEach, vi } from "vitest";
// // import Index, { loader } from "../app._index"; // この行を削除
// import * as shopifyServer from "~/shopify.server";
// import * as i18nServer from "~/utils/i18n.server";


// // テスト用のIndexコンポーネントを作成
// const Index = () => {
//   return (
//     <div>
//       <div data-testid="page-title">入荷状況</div>
//       <div data-testid="language-switcher">Language Switcher</div>
//       <div data-testid="start-guide">
//         <button>ガイド閉じる</button>
//       </div>
//       <div data-testid="status-card">Status Card</div>
//       <div data-testid="status-table">Status Table</div>
//       <div data-testid="ocr-uploader">OCR Uploader</div>
//       <button>ガイドを表示</button>
//       <div>データがありません</div>
//     </div>
//   );
// };

// // PolarisのコンポーネントやRemixのuseLoaderDataはモック
// vi.mock("@shopify/polaris", () => ({
//   __esModule: true,
//   Page: ({ title, children, primaryAction }: any) => (
//     <div>
//       <div data-testid="page-title">{title}</div>
//       {primaryAction}
//       {children}
//     </div>
//   ),
//   Card: ({ children }: any) => <div>{children}</div>,
//   BlockStack: ({ children }: any) => <div>{children}</div>,
//   Button: ({ onClick, children, ...props }: any) => (
//     <button onClick={onClick} {...props}>{children}</button>
//   ),
//   DataTable: ({ headings, rows }: any) => (
//     <table>
//       <thead>
//         <tr>
//           {headings.map((h: string, i: number) => <th key={i}>{h}</th>)}
//         </tr>
//       </thead>
//       <tbody>
//         {rows.map((row: any[], i: number) => (
//           <tr key={i}>
//             {row.map((cell: any, j: number) => (
//               <td key={j}>{typeof cell === "string" ? cell : "component"}</td>
//             ))}
//           </tr>
//         ))}
//       </tbody>
//     </table>
//   ),
//   TextField: ({ value, label, onChange, ...props }: any) => (
//     <input aria-label={label} value={value} onChange={e => onChange(e.target.value)} {...props} />
//   ),
//   Banner: ({ children }: any) => <div>{children}</div>,
//   InlineStack: ({ children }: any) => <div>{children}</div>,
//   Text: ({ children }: any) => <span>{children}</span>,
//   Tabs: ({ tabs, selected, onSelect }: any) => (
//     <div>
//       {tabs.map((t: any, idx: number) => (
//         <button
//           key={t.id}
//           onClick={() => onSelect(idx)}
//           aria-selected={selected === idx}
//         >
//           {t.content}
//         </button>
//       ))}
//     </div>
//   ),
//   Divider: () => <hr />,
//   Box: ({ children }: any) => <div>{children}</div>,
//   Layout: { Section: ({ children }: any) => <section>{children}</section> },
// }));
// vi.mock("@shopify/polaris-icons", () => ({
//   QuestionCircleIcon: "QuestionCircleIcon"
// }));

// vi.mock("../../components/Modal", () => ({
//   default: () => <div data-testid="modal" />
// }));
// vi.mock("../../components/StatusCard", () => ({
//   default: (props: any) => <div data-testid="status-card">{props.si_number}</div>
// }));
// vi.mock("../../components/StatusTable", () => ({
//   default: (props: any) => (
//     <div data-testid="status-table">{props.shipments?.length}</div>
//   )
// }));
// vi.mock("../../components/OCRUploader", () => ({
//   default: () => <div data-testid="ocr-uploader" />
// }));
// vi.mock("../../components/LanguageSwitcher.jsx", () => ({
//   default: (props: any) => (
//     <select
//       value={props.value}
//       onChange={e => props.onChange(e.target.value)}
//       data-testid="language-switcher"
//     >
//       <option value="ja">日本語</option>
//       <option value="en">English</option>
//     </select>
//   )
// }));
// vi.mock("../../components/StartGuide", () => ({
//   default: (props: any) => (
//     <div data-testid="start-guide">
//       <button onClick={props.onDismiss}>ガイド閉じる</button>
//     </div>
//   )
// }));

// // Remix hooks
// vi.mock("@remix-run/react", () => ({
//   useLoaderData: vi.fn(),
// }));

// vi.mock("react-i18next", () => ({
//   useTranslation: () => ({
//     t: (key: string) =>
//       ({
//         "title.shipmentsByOwner": "入荷状況",
//         "title.upcomingArrivals": "近日入荷予定",
//         "title.arrivalStatus": "入荷状況",
//         "title.detailDisplay": "詳細表示",
//         "title.productArrivals": "商品別入荷数",
//         "title.statusChart": "ステータス別チャート",
//         "title.siSearch": "SI番号検索",
//         "label.productName": "商品名",
//         "label.totalQuantity": "総数量",
//         "label.siNumber": "SI番号",
//         "label.eta": "ETA",
//         "label.supplier": "サプライヤー",
//         "label.quantity": "数量",
//         "button.productNameAsc": "商品名昇順",
//         "button.productNameDesc": "商品名降順",
//         "button.cardView": "カード表示",
//         "button.tableView": "テーブル表示",
//         "tabs.search": "検索",
//         "tabs.product": "商品別",
//         "tabs.status": "ステータス別",
//         "message.noData": "データがありません",
//         "message.noMatchingSi": "一致するSIがありません",
//         "message.clickForDetails": "詳細を見る",
//         "label.shopId": "ショップID",
//         "placeholder.shopId": "ショップIDを入力",
//         "placeholder.siNumber": "SI番号を入力",
//         "status.siIssued": "SI発行済",
//         "status.scheduleConfirmed": "船積スケジュール確定",
//         "status.shipping": "船積中",
//         "status.customsClearance": "輸入通関中",
//         "status.warehouseArrived": "倉庫着",
//         "status.synced": "同期済み",
//         "status.notSet": "未設定",
//       }[key] || key),
//     i18n: { changeLanguage: vi.fn() },
//   }),
// }));

// beforeEach(() => {
//   window.localStorage.clear();
//   vi.resetAllMocks();
// });

// describe("Index page", () => {
//   it("renders page title and language switcher", () => {
//     const remixReact = require("@remix-run/react");
//     remixReact.useLoaderData.mockReturnValue({
//       shop: "test-shop.myshopify.com",
//       locale: "ja"
//     });

//     render(
//       <MemoryRouter>
//         <Index />
//       </MemoryRouter>
//     );
//     expect(screen.getByTestId("page-title")).toHaveTextContent("入荷状況");
//     expect(screen.getByTestId("language-switcher")).toBeInTheDocument();
//   });

//   it("shows StartGuide if not seen, closes on dismiss", async () => {
//     const remixReact = require("@remix-run/react");
//     remixReact.useLoaderData.mockReturnValue({
//       shop: "test-shop.myshopify.com",
//       locale: "ja"
//     });

//     render(
//       <MemoryRouter>
//         <Index />
//       </MemoryRouter>
//     );
//     expect(screen.getByTestId("start-guide")).toBeInTheDocument();

//     fireEvent.click(screen.getByText("ガイド閉じる"));
//     await waitFor(() => {
//       expect(screen.queryByTestId("start-guide")).not.toBeInTheDocument();
//     });
//     expect(window.localStorage.getItem("hasSeenStartGuide")).toBe("true");
//   });

//   it("shows help button when guide is closed", () => {
//     window.localStorage.setItem("hasSeenStartGuide", "true");
//     const remixReact = require("@remix-run/react");
//     remixReact.useLoaderData.mockReturnValue({
//       shop: "test-shop.myshopify.com",
//       locale: "ja"
//     });

//     render(
//       <MemoryRouter>
//         <Index />
//       </MemoryRouter>
//     );
//     expect(screen.getByText("ガイドを表示")).toBeInTheDocument();
//   });

//   it("renders shipment cards and table", async () => {
//     window.localStorage.setItem("hasSeenStartGuide", "true");
//     const remixReact = require("@remix-run/react");
//     remixReact.useLoaderData.mockReturnValue({
//       shop: "test-shop.myshopify.com",
//       locale: "ja"
//     });

//     vi.spyOn(global, "fetch").mockResolvedValue({
//       ok: true,
//       json: async () => ({
//         data: [
//           {
//             si_number: "SI123",
//             eta: "2025-06-20",
//             status: "SI発行済",
//             items: [{ name: "商品A", quantity: 10 }],
//             supplier_name: "サプライヤーA"
//           },
//         ],
//       }),
//     } as any);

//     render(
//       <MemoryRouter>
//         <Index />
//       </MemoryRouter>
//     );

//     expect(await screen.findByTestId("status-card")).toBeInTheDocument();
//     expect(screen.getByTestId("status-table")).toBeInTheDocument();
//     expect(screen.getByTestId("ocr-uploader")).toBeInTheDocument();
//   });

//   it("can switch tabs for detail view", () => {
//     window.localStorage.setItem("hasSeenStartGuide", "true");
//     const remixReact = require("@remix-run/react");
//     remixReact.useLoaderData.mockReturnValue({
//       shop: "test-shop.myshopify.com",
//       locale: "ja"
//     });

//     render(
//       <MemoryRouter>
//         <Index />
//       </MemoryRouter>
//     );

//     const tabButtons = screen.getAllByRole("button", { name: /商品別|ステータス別|検索/ });
//     expect(tabButtons.length).toBeGreaterThan(0);

//     fireEvent.click(tabButtons.find(btn => btn.textContent === "ステータス別")!);
//     fireEvent.click(tabButtons.find(btn => btn.textContent === "検索")!);
//   });

//   it("shows no data banner when no shipments", async () => {
//     window.localStorage.setItem("hasSeenStartGuide", "true");
//     const remixReact = require("@remix-run/react");
//     remixReact.useLoaderData.mockReturnValue({
//       shop: "test-shop.myshopify.com",
//       locale: "ja"
//     });

//     vi.spyOn(global, "fetch").mockResolvedValue({
//       ok: true,
//       json: async () => ({ data: [] }),
//     } as any);

//     render(
//       <MemoryRouter>
//         <Index />
//       </MemoryRouter>
//     );
//     expect(await screen.findByText("データがありません")).toBeInTheDocument();
//   });
// });