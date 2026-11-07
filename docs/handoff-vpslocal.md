# Track to Inventory — 新作業環境への引き継ぎ

更新時点: 2026-11-07

## リポジトリ状態

- ブランチ: `main`
- `origin/main`と同期済み
- 未コミット差分・未追跡ファイルなし
- 最新コミット: `2fb699b chore: upgrade runtime to Node.js 22`

## 現在の構成

- 本番Worker: `track-to-inventory-web`
- 本番データ正本: Cloudflare D1
- Worker設定: `apps/web/wrangler.jsonc`
- Node.js指定: root / `apps/web`ともに`22.x`
- Docker: `apps/web/Dockerfile`で`node:22-alpine`

## Cloudflare Workers Builds

DashboardのBuild設定は次の状態。

- Build command: `npm run build`
- Deploy command: `npm run -w @track-to-inventory/web deploy:cf`
- Root directory: `/`
- Production branch: `main`
- Build variable: `NODE_VERSION=22`

Node 22更新前のBuildは、CloudflareがNode 20.20.2を選択したため`EBADENGINE`で失敗した。`NODE_VERSION=22`保存後、失敗BuildをRetryして結果を確認すること。

## 実施済みの重要変更

- `4bd6882`: `/api/usage`と`/api/ai-parse`でquery/bodyの`shop_id`を店舗識別に使わず、Shopify認証済みsessionのshopへ固定。未認証・店舗不一致の検証を追加。
- `2fb699b`: Node.js 20.xから22.xへ更新。

## 検証状況

- Node 22でbuildは成功。
- `git diff --check`は成功。
- typecheckは既存のPrisma型エラーで失敗中。
  - `apps/web/app/db.server.ts:11`
  - `Prisma.PrismaClientOptions`が現在の生成済みPrisma型に存在しない。
- build時にVite/Rolldownのdeprecated warningが出るが、buildは成功している。

## Shopify期限付きoffline token監査

2026-10-22に本番D1をSELECTのみで監査した。

- 稼働中6店舗は`token_expires_at`、暗号化token、fingerprintを保持。
- D1監査の`rows_written=0`、`changes=0`。
- token本文・refresh token本文・復号値は取得・表示していない。
- refresh tokenの有無は暗号化本文のためD1 metadataだけでは確定不能。
- `wrangler tail`ではrefresh/401/403の新規イベントを短時間確認したが、過去ログの履歴検索はできないため、直近履歴の不存在は断定していない。

## 新環境での確認コマンド

```bash
npm ci
npm run build
npm run typecheck -w @track-to-inventory/web
git diff --check
```

Cloudflare操作は、本番D1への書き込み、secret変更、token交換、deployを意図しているか確認してから実施すること。secret値はリポジトリや引き継ぎ文書へコピーしない。
