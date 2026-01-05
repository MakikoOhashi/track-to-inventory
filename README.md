# Track to Inventory - Shopify入荷管理アプリ

Shopifyストアの「入荷・在庫連携」を効率化するプロフェッショナル向け業務アプリです。

Track to Inventoryは、Shopifyストアの入荷管理を効率化するためのアプリです。船荷証券（SI）の追跡から在庫同期まで、輸入ビジネスに必要な機能を一つのアプリで提供します。

## 🚀 主な機能

### 📦 入荷管理
- **SI番号追跡**: 船荷証券（SI）のステータス管理
- **入荷予定管理**: ETD/ETAによる入荷スケジュール管理
- **ステータス管理**: SI発行済みから倉庫着まで6段階のステータス
- **商品別管理**: 積載商品の詳細管理

### 🔍 OCR機能
- **画像・PDF対応**: インボイスやパッキングリストから自動テキスト抽出
- **AI補完**: Google Geminiによる未入力項目の自動補完（日本語文脈にも対応）
- **手動入力**: OCRを使わない直接入力も可能
- **使用制限**: プラン別の月間使用回数制限

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
├── app/
│   ├── components/          # UIコンポーネント
│   ├── config/              # 設定ファイル
│   ├── lib/                 # ユーティリティ関数
│   ├── locales/             # 多言語リソース
│   ├── routes/              # ルーティングとAPIエンドポイント
│   ├── utils/               # ユーティリティ関数
│   ├── db.server.ts         # データベース接続
│   ├── shopify.server.ts    # Shopify認証設定
│   ├── entry.client.tsx     # クライアントエントリポイント
│   ├── entry.server.jsx     # サーバーエントリポイント
│   ├── root.jsx             # ルートコンポーネント
│   └── routes.js            # ルート定義
├── prisma/                  # Prismaスキーマとマイグレーション
├── public/                  # 静的アセット
├── types/                   # TypeScript型定義
└── extensions/              # Shopify拡張機能
```

### 🔧 主要コンポーネント

#### 1. **認証システム**
- `app/shopify.server.ts`: Shopify OAuth認証とセッション管理
- `app/db.server.ts`: Prismaベースのデータベース接続
- セキュアなHMAC検証とShopify API統合
- セッションストレージ: Prisma + SQLite

#### 2. **データモデル**
- **Prismaスキーマ**: SQLiteベースのセッション管理
- **Supabase統合**: クラウドデータベースとリアルタイム機能
- **Redisキャッシュ**: Upstash Redisによる使用制限管理
- **データフロー**: Shopify → アプリ → Supabase → Redis

#### 3. **APIエンドポイント**
- `api.shipments.ts`: 入荷情報のCRUD操作
- `api.ai-parse.ts`: Google Gemini AIによるデータ解析
- `api.sync-stock.ts`: Shopify在庫同期
- `api.ocr-limit.js`: OCR使用制限管理
- `api.uploadShipmentFile.ts`: ファイルアップロード処理
- `api.pdf2image.ts`: PDFから画像変換

#### 4. **UIコンポーネント**
- **StatusCard**: 視覚的なステータスカード表示
- **StatusTable**: テーブル形式のデータ表示
- **OCRUploader**: 画像/PDFアップロードとOCR処理
- **LanguageSwitcher**: 多言語切り替え
- **Modal**: 詳細情報表示モーダル
- **StartGuide**: 初期ガイド表示

#### 5. **メインビュー**
- `app/routes/app._index.tsx`: ダッシュボードとメインインターフェース
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
Shopify Store → Shopify API → Remixアプリ → Supabase → Redis
          ↑                                      ↓
     ユーザーインターフェース ← Shopify Polaris UI
```

#### 3. **ステータス管理**
- 6段階の入荷ステータス:
  1. SI発行済み
  2. 船積スケジュール確定
  3. 船積中
  4. 輸入通関中
  5. 倉庫着
  6. 同期済み

#### 4. **OCR処理フロー**
```
画像/PDFアップロード → Tesseract.js OCR → テキスト抽出 →
Google Gemini AI → データ補完 → Supabase保存 → Shopify同期
```

#### 5. **多言語サポート**
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

- **フレームワーク**: [Remix](https://remix.run)
- **Shopify統合**: [@shopify/shopify-app-remix](https://shopify.dev/docs/api/shopify-app-remix)
- **UI**: [Shopify Polaris](https://polaris.shopify.com/)
- **データベース**: [Supabase](https://supabase.com/) (PostgreSQL)
- **OCR**: [Tesseract.js](https://tesseract.projectnaptha.com/)
- **AI**: [Google Gemini](https://ai.google.dev/)
- **ファイルストレージ**: [Upstash Redis](https://upstash.com/)
- **国際化**: [react-i18next](https://react.i18next.com/)

## 📋 前提条件

開発を始める前に、以下が必要です：

1. **Node.js**: v18.20以上またはv20.10以上
2. **Shopify Partner Account**: [アカウント作成](https://partners.shopify.com/signup)
3. **テストストア**: [開発ストア](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store)または[Plus サンドボックス](https://help.shopify.com/en/partners/dashboard/managing-stores/plus-sandbox-store)
4. **Supabase**: データベース用のSupabaseプロジェクト
5. **Google Cloud**: Gemini API用のプロジェクトとAPIキー
6. **Upstash**: Redis用のUpstashプロジェクト

## ⚙️ セットアップ

### 1. リポジトリのクローンと依存関係のインストール

```bash
git clone <repository-url>
cd track-to-inventory
npm install
```

### 2. 環境変数の設定

`.env`ファイルを作成し、以下の環境変数を設定してください：

```env
# Shopify
SHOPIFY_API_KEY=your_shopify_api_key
SHOPIFY_API_SECRET=your_shopify_api_secret
SHOPIFY_SCOPES=write_products,read_products,write_inventory,read_inventory
SHOPIFY_APP_URL=https://your-app-url.com

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key

# Upstash Redis
UPSTASH_REDIS_REST_URL=your_upstash_redis_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token

# その他
NODE_ENV=development
```

### 3. データベースのセットアップ

```bash
# Prismaクライアントの生成
npx prisma generate

# データベースマイグレーションの実行
npx prisma migrate deploy
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

### ビルド

```bash
npm run build
```

### テスト

```bash
# テストの実行
npm run test

# テストUIの起動
npm run test:ui
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

- **Freeプラン**: 月間OCR使用回数制限あり
- **Proプラン**: 制限なし、全機能利用可能

### ファイルアップロード制限

- 最大ファイルサイズ: 10MB
- 対応形式: 画像（JPG, PNG, GIF）、PDF

## 🚀 デプロイ

### Vercelでのデプロイ

1. Vercelプロジェクトを作成
2. 環境変数を設定
3. デプロイを実行

```bash
npm run deploy
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

## 📝 ライセンス

このプロジェクトはMITライセンスの下で公開されています。

## 🤝 コントリビューション

1. このリポジトリをフォーク
2. 機能ブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add some amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

## 📞 サポート

- **ドキュメント**: [Notion](https://www.notion.so/track-to-inventory-211c3eba44cb803dbc79f9a485bc8342)
- **Issues**: GitHub Issuesでバグ報告や機能要望
- **Email**: サポート用メールアドレス　ohashinaomaki@gmail.com

## 🔄 更新履歴

詳細な変更履歴は[CHANGELOG.md](./CHANGELOG.md)を参照してください。

---

**Track to Inventory** - Shopify入荷管理を効率化するための最適なソリューション


---

## 🇺🇸 English Summary

### Track to Inventory – Shopify Inventory Management App

**Track to Inventory** is a Shopify app designed to streamline the inventory management process for import-based businesses.  
It provides powerful features for tracking shipping instructions (SI), managing arrival schedules, synchronizing stock with Shopify, and automating data extraction using OCR and AI.

### 🔧 Key Features

- **SI Tracking**: Manage six detailed status stages from SI creation to warehouse arrival  
- **Arrival Scheduling**: Plan inbound shipments using ETD/ETA dates  
- **OCR + AI**: Extract data from invoices and packing lists with Tesseract.js and auto-fill missing values using Google Gemini  
- **Shopify Sync**: Automatically update Shopify inventory based on shipment status  
- **File Management**: Upload and preview related files securely (e.g., invoices, SI, packing lists)  
- **Multilingual UI**: Fully supports both Japanese and English with real-time language switching

### 🛠 Tech Stack

- **Framework**: Remix  
- **UI**: Shopify Polaris  
- **Database**: Supabase (PostgreSQL)  
- **OCR**: Tesseract.js  
- **AI**: Google Gemini  
- **Storage**: Upstash Redis  
- **Internationalization**: react-i18next

---

For any inquiries, testing access, or support, feel free to reach out.  
This app is designed for operational efficiency in real-world import workflows.

Support [Notion]：https://quiet-thrill-c13.notion.site/Track-To-Inventory-User-Guide-217c3eba44cb80ffa65ce7df3fde3cf8
