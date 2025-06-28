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

### その他のプラットフォーム

- **Heroku**: `heroku create && git push heroku main`
- **Fly.io**: `fly launch`
- **Railway**: Railway Dashboardから直接デプロイ

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
- **Email**: サポート用メールアドレス

## 🔄 更新履歴

詳細な変更履歴は[CHANGELOG.md](./CHANGELOG.md)を参照してください。

---

**Track to Inventory** - Shopify入荷管理を効率化するための最適なソリューション
