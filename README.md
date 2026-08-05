# TrackToInventory

Shopify Embedded Appとして動作する入荷管理アプリです。現行の本番構成は、Shopify、Cloudflare Worker、Cloudflare D1の単一構成です。

## 現行アーキテクチャ

```text
Shopify Admin
    │  Embedded App / Admin API / Webhook
    ▼
Cloudflare Worker (apps/web)
    ├─ React Router + Shopify Polaris UI
    ├─ 認証・session保存 ───────────────┐
    ├─ shipment / item CRUD ────────────┤
    ├─ OCR・AI補完 (Gemini) ────────────┤→ Cloudflare D1 (TTI_DB)
    └─ Shopify在庫同期 (Admin GraphQL) ─┘
```

- Worker名: `track-to-inventory-web`
- Worker設定: [`apps/web/wrangler.jsonc`](apps/web/wrangler.jsonc)
- D1 binding: `TTI_DB`（database `track-to-inventory`）
- 静的アセット: Workerの`ASSETS` binding
- 本番の読み書きはD1のみ。Supabase、Redis、Render、Notionはruntime経路にありません。

### D1が正本のデータ

- `shopify_sessions`: Shopify session。期限付きoffline tokenは暗号化フィールド（`token_ciphertext`）に保存し、expiry・fingerprint・generationを管理します。`payload_json`やログにtoken本文を保存しません。
- `shipments`: SI単位の入荷予定本体
- `shipment_items`: shipmentの商品明細。`sort_order`と安定したitem IDを保持します。
- `inventory_sync_ledger`: Shopify在庫同期のidempotency、claim、retry、完了状態の台帳
- `shop_plans`、`usage_operations`、`usage_counters`: planとOCR／AI／delete等の利用量。D1固定で、Redis fallbackやmode flagはありません。
- `file_objects`: D1スキーマにはありますが、現行Workerに永続ファイル保存routeはありません。実行時に参照されるファイル保存先として扱わないでください。

## 現在のデータフロー

1. Embedded AppからのrequestをShopify認証で検証し、認証済みsessionのshop domainを使用します。request bodyのshop IDは認可に使用しません。
2. shipmentの作成・更新・削除とitemの追加・変更・置換は、`shipments`と`shipment_items`へ直接保存します。
3. `/api/document-parse`はmultipartの画像・PDF・テキスト（最大10MB）をWorkerで検証し、Geminiへ送り、抽出結果と画像previewを返します。OCR利用量はD1でreserveし、失敗時にrefundします。ファイルバイナリを本番Storageへ保存する処理は現行routeにありません。
4. shipmentの`invoice_url`、`pl_url`、`si_url`、`other_url`は、入力されたURL文字列としてD1に保持できます。URL先のStorage管理はこのWorkerの責務ではありません。
5. `/api/sync-stock`はD1のshipment/itemを読み、`inventory_sync_ledger`で重複実行を防ぎながらShopify Admin GraphQLの在庫調整を行います。結果と再試行状態もD1へ記録します。
6. アンインストールwebhookはsessionをtombstone化し、認証token情報を消去します。shop domainに紐づくshipment、item、ledgerなどの業務データは削除しません。完全削除は別の明示的処理です。

## 主な画面とroute

### Embedded App画面

- `/app`: 入荷予定一覧、カード／テーブル表示、検索、OCR入力、在庫同期導線
- `/app/pricing`: Shopify Billingのplan表示・購読導線
- `/app/contact`: 問い合わせ画面

### API

- `/api/shipments`: 認証shopの一覧取得
- `/api/createShipment`: shipment作成
- `/api/updateShipment`: shipmentとitem更新
- `/api/delete-shipment`: shipment削除（利用量制限をD1で確認）
- `/api/document-parse`: Gemini OCR
- `/api/ai-parse`: Geminiによる入力補完
- `/api/sync-stock`: Shopify在庫同期とledger参照
- `/api/usage`: D1利用量表示
- `/api/shopify/products`、`/api/shopify/graphql`: Shopify Admin API補助経路
- `/api/auth-context`、`/api/billing-subscribe`:認証・課金補助経路

### Webhook

- `app/uninstalled`: session tombstone化と認証情報消去（業務データ保持）
- `app/scopes_update`: session再保存
- `app/shop_redact`、`app/customers_data_request`、`app/customers_redact`: Shopifyのdata privacy webhook

Notion OAuth／API route、Redis route、Render OCR API routeは存在しません。

## 現行productionの確認スナップショット

2026-07-28のread-only確認時点です。運用上の現在値として利用する場合は、D1を再確認してください。

| shop                             | shipments | shipment_items | inventory_sync_ledger |
| -------------------------------- | --------: | -------------: | --------------------: |
| `luckywifi-0.myshopify.com`      |         3 |              8 |                     2 |
| `xn-edkuc877j9g5b.myshopify.com` |         0 |              0 |                     0 |

- `shopify_sessions`: 2行（上記2 shop）
- D1 read-only queryの書き込み件数: 0
- production Worker: `track-to-inventory-web`

## 外部サービスの扱い

### Supabase

Supabaseはruntime・production secretともに脱却済みです。shipment、item、ledger、sessionの本番正本はD1です。旧Supabaseの`shipments`、`inventory_sync_ledger`テーブルとStorageの`shipment-files`バケットは、最終バックアップ取得後に削除済みです。

最終バックアップはローカルの[`apps/supabase-backup-2026-08-04`](apps/supabase-backup-2026-08-04)に保存しています。内容は、SupabaseテーブルのJSON export（shipments 4行、inventory_sync_ledger 2行）、PostgRESTスキーマ、Storageメタデータ、およびStorageファイル4件（約3.37MB）です。バックアップには本番データ・ファイルが含まれるため、Git管理対象外です。

### Upstash Redis

Upstash DBは`ruidaichan`／`wakarumade`など他プロジェクトと共有されているため存続します。TrackToInventoryのWorkerはRedisを参照せず、production Worker secretからもRedis URL／tokenを除去済みです。共有DBの他プロジェクトkeyは変更しません。

### Render

RenderのOCR／APIサービスは撤去済みです。OCRはWorkerからGeminiを呼び出します。Render用の過去資料がリポジトリに残っていても、現行runtimeの構成ではありません。

### Notion

Notion連携は未提供で、画面、OAuth、API、cleanup、Redis処理を削除済みです。将来構想や過去のmigration名を、現行機能として扱わないでください。

## 開発・確認

必要環境はNode.js 20です。

```bash
npm install
cd apps/web
npm run d1:migrate:local
npm run build
```

Cloudflare Workerへdeployする場合:

```bash
cd apps/web
npm run build
npm run deploy:cf
```

本番migration、secret操作、deployは、対象WorkerとD1を確認してから人間の承認を得て実行してください。token本文やsecret本文を出力しないでください。

## 技術スタック

- Shopify Embedded App / Admin API / Webhook
- Cloudflare Workers
- React Router、Shopify Polaris
- Cloudflare D1（業務データ、session、usage、plan、ledger）
- Gemini API（OCR・AI補完）
- `react-i18next`（日本語・英語）

## English summary

TrackToInventory is a Shopify Embedded App running as a single Cloudflare Worker with Cloudflare D1 as the sole production data authority. Sessions, shipments, shipment items, usage/plan records, and the inventory-sync ledger are stored in D1. OCR and AI parsing run in the Worker through Gemini, and inventory adjustments use the Shopify Admin GraphQL API with an idempotent D1 ledger.

Render, Redis, Notion, and Supabase are not runtime dependencies. The Upstash database remains because it is shared with other projects, but this app no longer reads it. Legacy Supabase tables and the `shipment-files` Storage bucket were deleted after the final local backup on 2026-08-04.
