# Inbound Tracking (formerly Track to Inventory) - Shopify入荷前管理アプリ

Shopify App Store の審査を通過し、公開まで到達した Shopify Embedded App です。

Inbound Tracking（旧称: Track to Inventory）は、Shopifyストアの入荷前フローを見える化するためのアプリです。船荷証券（SI）の追跡から在庫同期まで、輸入ビジネスに必要な機能を一つのアプリで提供します。

このリポジトリのポートフォリオ上の価値は、機能量そのものよりも、実際に Shopify アプリとして設計し、認証・埋め込み表示・課金導線・運用を含めて公開審査を通した点にあります。

## 🆕 Recent Updates

- **Usage / plan を Cloudflare D1 へ移行**（Stage L5）: OCR・AI・delete の月次利用量と Shopify Billing 由来の plan の正本は D1。旧 Redis usage/plan 経路とキーは撤去済み（`USAGE_D1_MODE` 廃止・D1 固定）
- **Shopify session を Cloudflare D1 へ固定**（Stage L6.0）: `SESSION_D1_MODE` と Redis session 互換経路を撤去。セッション正本は D1 固定。旧 Redis session キー自体は未削除（別 Stage）
- Cloudflare Workers をフロント本体として安定化し、Shopify Embedded App としての起動導線を整理
- App Bridge の初期化を見直し、埋め込みナビゲーション表示を改善
- 初回の全画面 `Loading...` を短縮し、トップ画面の表示体感を改善
- `ステータスごとの入荷予定` で、ローカライズされたステータス値を正しく集計するよう修正
- 商品明細が未登録でも、ステータス別一覧で shipment 自体は確認できるよう表示を改善
- `main` を現行の本線として整理し、Shopify Embedded App のフロントを Cloudflare Workers 前提の構成へ統一
- 書類解析・ファイル・在庫同期を Workers 上で完結させ、Render 依存を撤去

## ⭐ ポートフォリオ観点のポイント

- Shopify Embedded App として実装し、公開審査を通過した実績
- Shopify OAuth、App Bridge、Webhook、課金ページ導線を含む実運用前提の構成
- Gemini API による書類解析・AI補完を含む業務入力補助
- 小規模でも「作って終わり」ではなく、公開可能な形まで完走したプロジェクト

## 🚀 主な機能

### 📦 入荷管理

- **SI番号追跡**: 船荷証券（SI）のステータス管理
- **入荷予定管理**: ETD/ETAによる入荷スケジュール管理
- **ステータス管理**: SI発行済みから倉庫着まで6段階のステータス
- **商品別管理**: 積載商品の詳細管理

### 🔍 OCR機能

- **画像・PDF対応**: インボイスやパッキングリストから自動テキスト抽出
- **AI補完**: Gemini APIによる未入力項目の自動補完（日本語文脈にも対応）
- **手動入力**: OCRを使わない直接入力も可能
- **使用制限**: プラン別の月間使用回数制限（正本は Cloudflare D1）

### 🔄 Shopify同期

- **在庫同期**: 入荷情報をShopify在庫と自動同期
- **商品マッピング**: Shopify variant IDとの連携
- **リアルタイム更新**: 入荷状況の即座反映

### 📁 ファイル管理

- **関連ファイル**: インボイス、パッキングリスト、SI等の管理
- **プレビュー機能**: アップロードしたファイルの表示
- **セキュア保存**: 安全なファイルストレージ

### 🌐 多言語対応

- **日本語・英語**: 完全な多言語サポート
- **動的切り替え**: リアルタイム言語変更

## 🗂️ ファイル構造と設計

### 📁 アプリケーション構造

```
track-to-inventory/
├── apps/
│   └── web/                 # Shopify Embedded App（Cloudflare Workers）
│       ├── app/             # UI・ルート・API
│       ├── migrations/      # Cloudflare D1 SQL マイグレーション
│       ├── prisma/          # Prismaスキーマ（補助用途）
│       ├── public/          # 静的アセット
│       ├── workers/         # Workers エントリ
│       └── extensions/      # Shopify拡張機能
├── packages/
│   └── shared/              # 共有型・utility
└── docs/                    # 設計・移行メモ
```

`apps/web` が Shopify Embedded App の本体です。書類解析（Gemini）、出荷ファイル（Supabase Storage）、在庫同期（Shopify Admin API）、利用量・plan（D1）はすべて Cloudflare Workers 上で動作します。

### 🔧 主要コンポーネント

#### 1. **認証システム**

- `apps/web/app/shopify.server.ts`: Shopify OAuth認証とセッション管理
- セッション正本: Cloudflare D1（`SESSION_D1_MODE` 廃止・D1 固定。旧 Redis session 互換経路は撤去済み）
- セキュアなHMAC検証とShopify API統合

#### 2. **データモデル**

- **Supabase (PostgreSQL)**: shipments 等の業務データとファイル Storage
- **Cloudflare D1**: Shopify セッション、利用量・plan、在庫同期 ledger の shadow 比較用テーブル
- **Upstash Redis**: inventory sync ledger / Notion 接続など（**session・usage・plan の正本ではない**。旧 usage/plan キーは削除済み。旧 session キーは別 Stage で削除予定）
- **Notion 接続メタデータ**: D1 repository（`notionMetadata.server.ts`）と migration `0003` は L8.1 まで実装済みだが、**ユーザー向け Notion 連携未実装のため L8 系列はここで保留**。ランタイム正本は引き続き Redis（`notionConnection.server.ts`）。詳細は [`docs/d1-r2-redesign.md` §8.1](docs/d1-r2-redesign.md)
- **データフロー**: Shopify Admin → Cloudflare Workers → Supabase / D1（＋必要に応じて Redis）

##### Shipments（L9.3 shadow）

- `D1_SHIPMENTS_MODE=off`: D1比較・mirrorなし
- `D1_SHIPMENTS_MODE=shadow`: Supabase primaryのままread比較・成功後write mirror
- `D1_SHIPMENTS_READ_MODE=supabase|d1`: user-facing readの正本。未設定・不正値は`supabase`
- `D1_SHIPMENTS_WRITE_MODE=off|shadow`: write mirror。未設定時はlegacy
  `D1_SHIPMENTS_MODE=shadow|d1`を`shadow`として扱い、現行挙動を維持
- D1 readエラー時だけSupabaseへfallbackする。正常な空結果ではfallbackしない
- read rollbackは`D1_SHIPMENTS_READ_MODE=supabase`へ戻す。write primaryは引き続きSupabase
- 2026-07-26から本番shadow観測中（Supabase primary）
- 本番primary flip、Supabase削除、D1からのback-syncは未実施

##### Usage / plan（D1 正本）

| テーブル           | 役割                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shop_plans`       | ショップの plan（`free` / `basic` / `pro`）。Shopify Billing の `activeSubscriptions` を正として upsert。古い observation で新しい行を上書きしない |
| `usage_counters`   | 月次カウンタのデノーマライズ（`shop_id` + `kind` + `period_ym`）。正本は reserved 行の COUNT                                                       |
| `usage_operations` | operation_id 付き reserve / refund 台帳。OCR・AI・delete の二重加算・二重返却を防ぐ                                                                |

- **period_ym**: UTC の `YYYY-MM`（移行中もこの形式を維持）
- **kind**: `ocr` / `ai` / `delete`
- 本番 D1 には `0001_init_schema.sql` に加え **`0002_usage_operations.sql` 適用済み**
- かつての `USAGE_D1_MODE`（redis / shadow / d1_only）は **廃止**。実行時は D1 固定（feature flag なし）
- かつての `SESSION_D1_MODE`（off / shadow / dual_write / d1_primary / d1_only）も **廃止**。Shopify session も D1 固定

#### 3. **APIエンドポイント**

- `apps/web/app/routes/api.shipments.ts`: 入荷情報のCRUD操作
- `apps/web/app/routes/api.document-parse.ts`: Gemini による書類解析（OCR 利用は D1 reserve / 失敗時 refund）
- `apps/web/app/routes/api.ai-parse.ts`: Gemini APIによるデータ補完（AI 利用は D1）
- `apps/web/app/routes/api.delete-shipment.ts`: SI 削除（delete 利用は D1、成功後に加算）
- `apps/web/app/routes/api.usage.js`: 利用状況表示（D1 snapshot + Supabase SI 件数）
- `apps/web/app/routes/api.sync-stock.ts`: Shopify在庫同期
- `apps/web/app/routes/api.uploadShipmentFile.ts`: ファイルアップロード処理
- `apps/web/app/routes/api.get-file-url.ts`: 署名付きURL発行

#### 4. **UIコンポーネント**

- **StatusCard**: 視覚的なステータスカード表示
- **StatusTable**: テーブル形式のデータ表示
- **OCRUploader**: 画像/PDFアップロードとOCR処理
- **LanguageSwitcher**: 多言語切り替え
- **Modal**: 詳細情報表示モーダル
- **StartGuide**: 初期ガイド表示

#### 5. **メインビュー**

- `apps/web/app/routes/app._index.tsx`: ダッシュボードとメインインターフェース
- カード/テーブル表示切り替え
- 商品別/ステータス別/検索別表示モード
- リアルタイムデータ更新
- ポップアップ詳細表示

### 🏗️ アーキテクチャ設計

#### 1. **セキュリティ設計**

- Shopify OAuth 2.0認証
- HMACリクエスト検証
- セッションベースのアクセス制御
- 環境変数による機密情報管理

#### 2. **データフロー**

```
Shopify Admin → Cloudflare Workers (apps/web)
                    ├─ Supabase … shipments / files
                    ├─ D1 ……… sessions / usage+plan / ledger tables
                    └─ Redis …… inventory sync ledger, Notion 等（session / usage / plan 以外）
```

#### 3. **デプロイ方針**

- **本体**: Shopify Embedded App と API は `apps/web`（Cloudflare Workers + Wrangler）
- **意図**: 埋め込み UI・認証・課金・利用枠を同一 Worker 上で運用する

#### 4. **ステータス管理**

- 6段階の入荷ステータス:
  1. SI発行済み
  2. 船積スケジュール確定
  3. 船積中
  4. 輸入通関中
  5. 倉庫着
  6. 同期済み

#### 5. **OCR処理フロー**

```
画像/PDFアップロード → Gemini 書類解析 → テキスト抽出 →
（任意）AI補完 → Supabase保存 → Shopify同期
（利用枠は D1 の reserve / refund）
```

#### 6. **多言語サポート**

- 日本語/英語切り替え
- react-i18nextによる動的翻訳
- ローカルストレージによる言語設定保持

### 🔄 データ同期プロセス

1. **入荷情報登録**: OCRまたは手動入力
2. **ステータス更新**: ドラッグ&ドロップまたは手動更新
3. **在庫同期**: Shopify variant IDとのマッピング
4. **リアルタイム更新**: Supabaseリアルタイム機能

### 📊 表示モード

- **カード表示**: 視覚的なステータス概要
- **テーブル表示**: 詳細なデータ一覧
- **商品別表示**: 商品ごとの集計情報
- **ステータス別表示**: ステータスごとのグループ化
- **検索表示**: SI番号による検索

### 🔒 セキュリティ対策

- 環境変数による機密情報管理
- Shopifyセッション認証
- HMACリクエスト検証
- データアクセス制御
- エラーハンドリングとログ記録

## 🛠️ 技術スタック

- **ランタイム**: Cloudflare Workers（`apps/web`）
- **フレームワーク**: [React Router](https://reactrouter.com/)（Shopify App テンプレート系）
- **Shopify統合**: [@shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router)
- **UI**: [Shopify Polaris](https://polaris.shopify.com/)
- **業務 DB / Storage**: [Supabase](https://supabase.com/) (PostgreSQL)
- **セッション・利用量・plan**: [Cloudflare D1](https://developers.cloudflare.com/d1/)
- **補助ストア**: [Upstash Redis](https://upstash.com/)（inventory sync ledger / Notion 等。usage・plan は不使用）
- **OCR / 書類解析・AI補完**: [Gemini API](https://ai.google.dev/)
- **国際化**: [react-i18next](https://react.i18next.com/)

## 📋 前提条件

開発を始める前に、以下が必要です：

1. **Node.js**: v20 LTS
2. **Shopify Partner Account**: [アカウント作成](https://partners.shopify.com/signup)
3. **テストストア**: [開発ストア](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store)または[Plus サンドボックス](https://help.shopify.com/en/partners/dashboard/managing-stores/plus-sandbox-store)
4. **Supabase**: データベース用のSupabaseプロジェクト
5. **Gemini APIキー**: 書類解析・AI補完用
6. **Cloudflare**: Workers + D1（`TTI_DB` / マイグレーション `apps/web/migrations`）
7. **Upstash**: Redis（ledger / Notion 等の補助用途。usage・plan には不要）

## ⚙️ セットアップ

### 1. リポジトリのクローンと依存関係のインストール

```bash
git clone <repository-url>
cd track-to-inventory
nvm use
npm install
```

`.nvmrc` で `Node 20` を前提にしています。`Node 24` では依存整理や一部ツール実行で警告や不安定さが出ることがあります。

### 2. 環境変数の設定

`.env`ファイルを作成し、以下の環境変数を設定してください：

```env
# Shopify
SHOPIFY_API_KEY=your_shopify_api_key
SHOPIFY_API_SECRET=your_shopify_api_secret
SCOPES=read_locations,read_products,write_inventory,write_products
SHOPIFY_APP_URL=https://your-app-url.com

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Gemini API
GEMINI_API_KEY=your_gemini_api_key

# Upstash Redis（inventory sync ledger / Notion 等）
# ※ session / usage / plan の正本は D1。SESSION_D1_MODE / USAGE_D1_MODE は廃止済み
UPSTASH_REDIS_REST_URL=your_upstash_redis_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token

# D1 関連（Wrangler vars / Worker バインディング TTI_DB）
# session・usage/plan は D1 固定（mode flag なし）
INVSYNC_LEDGER_MODE=shadow
D1_LEDGER_MODE=shadow

# その他
NODE_ENV=development
```

詳細な変数一覧は `apps/web/.env.example` を参照してください。

### 3. データベースのセットアップ

```bash
# （補助）Prisma クライアント
npm run prisma -- generate

# Cloudflare D1 マイグレーション（ローカル）
cd apps/web
npm run d1:migrate:local
# 本番 remote は 0001 + 0002（usage_operations）適用済み
# npm run d1:migrate:remote
```

### 4. Shopifyアプリの設定

```bash
# Shopify CLIでアプリをリンク
npm run config:link

# 開発サーバーの起動
npm run dev
```

## 🚀 開発

### 開発サーバーの起動

```bash
npm run dev
```

Render 向け `apps/ocr-api` は Stage H で撤去済みです。履歴メモ: [docs/ocr-api-render-deploy.md](./docs/ocr-api-render-deploy.md)

### ビルド

```bash
npm run build
```

## 📖 使用方法

### 1. アプリのインストール

1. Shopify Partner Dashboardでアプリを作成
2. 開発ストアにアプリをインストール
3. 必要な権限を承認

### 2. 入荷情報の登録

#### OCRを使用した自動入力

1. 「画像アップロード & OCR」セクションに移動
2. インボイスやパッキングリストの画像/PDFをアップロード
3. 「OCR実行」ボタンをクリック
4. 必要に応じて「AIで未入力項目を補完」を実行
5. 内容を確認して「この内容で登録」をクリック

#### 手動入力

1. 「手動でSI情報を入力」ボタンをクリック
2. 必要な情報を直接入力
3. 「この内容で登録」をクリック

### 3. 入荷状況の管理

- **カード表示**: 視覚的に分かりやすいカード形式
- **テーブル表示**: 詳細な情報を一覧表示
- **ステータス管理**: ドラッグ&ドロップでステータス変更
- **検索機能**: SI番号による検索

### 4. Shopify在庫との同期

1. 入荷情報の詳細を開く
2. 「Shopify在庫と同期」ボタンをクリック
3. 同期状況を確認

## 🔧 設定

### プラン別制限

- **Free / Basic / Pro**: OCR・AI・delete・SI 登録に月次上限あり（詳細は Pricing 画面）
- 利用量と plan の正本は **Cloudflare D1**（`period_ym` = UTC `YYYY-MM`）
- Shopify Billing の active subscription が無い場合は `free`

### ファイルアップロード制限

- 最大ファイルサイズ: 10MB
- 対応形式: 画像（JPG, PNG, GIF）、PDF

## 🚀 デプロイ

### Cloudflare Workers

1. `apps/web` でビルド（Wrangler は build 生成の config redirect を使うため、vars 変更後は rebuild してから deploy）
2. シークレット / vars（`INVSYNC_LEDGER_MODE` 等）を確認
3. デプロイ

```bash
cd apps/web
npm run build
npx wrangler deploy
```

## 🐛 トラブルシューティング

### よくある問題

#### OCRが動作しない

- ファイル形式が対応しているか確認
- ファイルサイズが10MB以下か確認
- プランの使用制限に達していないか確認

#### Shopify同期が失敗する

- 商品の「数量を追跡する」が有効になっているか確認
- 商品の「配送が必要な商品です」が有効になっているか確認
- Shopify variant IDが正しく設定されているか確認

#### 認証エラーが発生する

- アプリを再インストール
- 環境変数が正しく設定されているか確認

### ログの確認

```bash
# 開発環境でのログ確認
npm run dev

# 本番環境でのログ確認（プラットフォーム依存）
```

## 🤝 コントリビューション

1. このリポジトリをフォーク
2. 機能ブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add some amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

## 📞 サポート

- **ドキュメント**: [Notion](https://quiet-thrill-c13.notion.site/Track-To-Inventory-User-Guide-211c3eba44cb803dbc79f9a485bc8342)
- **Issues**: GitHub Issuesでバグ報告や機能要望
- **Email**: サポート用メールアドレス　ohashinaomaki@gmail.com

## 🔄 更新履歴

詳細な変更履歴は[CHANGELOG.md](./CHANGELOG.md)を参照してください。

---

**Inbound Tracking** (formerly **Track to Inventory**) - Shopify入荷前管理を効率化するための最適なソリューション

---

## 🇺🇸 English Summary

### Inbound Tracking (formerly Track to Inventory) – Shopify Pre-Inventory Management App

**Inbound Tracking** (formerly **Track to Inventory**) is a Shopify app designed to streamline the pre-inventory management process for import-based businesses.  
It provides powerful features for tracking shipping instructions (SI), managing arrival schedules, synchronizing stock with Shopify, and automating data extraction using OCR and AI.

### 🔧 Key Features

- **SI Tracking**: Manage six detailed status stages from SI creation to warehouse arrival
- **Arrival Scheduling**: Plan inbound shipments using ETD/ETA dates
- **OCR + AI**: Extract data from invoices and packing lists with Gemini; usage quotas and plan live in Cloudflare D1
- **Shopify Sync**: Sync Shopify inventory from shipment data
- **File Management**: Upload and preview related files securely (e.g., invoices, SI, packing lists)
- **Multilingual UI**: Fully supports both Japanese and English with real-time language switching

### 🛠 Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: React Router
- **UI**: Shopify Polaris
- **App data**: Supabase (PostgreSQL)
- **Sessions / usage & plan**: Cloudflare D1 (`shop_plans`, `usage_counters`, `usage_operations`; `period_ym` = UTC `YYYY-MM`)
- **Auxiliary store**: Upstash Redis (inventory sync ledger, Notion, etc. — **not** session / usage / plan)
- **OCR / AI**: Gemini API
- **Internationalization**: react-i18next

Usage/plan Redis paths and keys have been removed; production D1 includes migration `0002_usage_operations`. There is no `USAGE_D1_MODE` flag — D1 is fixed.

---

For any inquiries, testing access, or support, feel free to reach out.  
This app is designed for operational efficiency in real-world import workflows.

Support [Notion]：https://quiet-thrill-c13.notion.site/Track-To-Inventory-User-Guide-217c3eba44cb80ffa65ce7df3fde3cf8
