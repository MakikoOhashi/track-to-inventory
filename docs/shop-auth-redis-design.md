# TrackToInventory 認証・店舗識別 × Upstash Redis 設計

調査日: 2026-07-24  
対象 TODO: リポジトリ直下 `TODO.md`  
方針: コード変更なし（調査・設計のみ）。秘密値・token 本文は記載しない。  
Emma (`emma-olivia-global.myshopify.com`) は移行対象データなし → 個別移行処理は作らない。

---

## 用語（混同禁止）

| 用語 | 意味 | 用途 |
|------|------|------|
| **shop domain** | `example.myshopify.com`（正規化後） | テナント主キー。Redis lookup、Notion 接続、利用回数 |
| **host** | App Bridge 用 base64 文字列 | 画面遷移・埋め込み UI のみ。認可に使わない |
| **session id** | 例: `offline_{shop}` / `{shop}_{userId}` | Shopify Session オブジェクトの主キー |
| **shop_id（現行 TTI コード）** | 実体は shop domain 文字列 | 歴史的命名。数値 Shopify Shop GID ではない |
| **session token / id_token** | App Bridge が発行する短命 JWT | リクエストごとの店舗確定の根拠 |
| **offline access token** | OAuth 完了後の長期 Admin API token | Redis に暗号化して保存。API 認可の直接入力にはしない |

---

## 1. MokuMoku の実際の認証・shop 引き継ぎフロー

### 1.1 本番相当 Worker UI 経路（`shopify-workers-poc.ts`）

```
GET /auth/login?shop=...
  → cookie shopify_oauth_state
  → Shopify /admin/oauth/authorize
GET /auth/callback (hmac + state 検証)
  → POST /admin/oauth/access_token
  → access_token は存在確認のみで破棄（永続化しない）
  → cookie mokumoku_shopify_session=present（認証根拠ではない）
  → /?shop&host&embedded=1
以降の API
  → extractRequestContext(request).shop
  → normalizeShopDomain
  → D1 の Notion/Slack/inbox を shop_domain で lookup
```

- Embedded session token / `id_token` の取得・検証は **行っていない**
- Worker API が最終的に信頼しているのは **URL query の `shop`（正規化後）**
- URL から shop が消えると、多くの API は 400。クライアントは `data-shop-domain` や query コピーで補完するが、サーバーは DOM を見ない
- `app/uninstalled` は Workers PoC には未実装（本体 Remix 側のみ）

### 1.2 PoC として存在する「正しい」経路（再利用価値が高い）

`custom-session-storage-smoke.ts` + `shopify-workers-legacy-app.ts`:

- `@shopify/shopify-api/adapters/cf-worker`
- `shopifyApp({ sessionStorage })`
- テスト用 session JWT（`aud`=apiKey, `dest`/`iss`=shop）を `Authorization: Bearer`
- `authenticate.admin(request)` で offline/online session を storage から復元

**TrackToInventory の目標本線に近いのはこちら**であり、MokuMoku の本番 UI 経路（query shop 信頼）ではない。

### 1.3 shop 正規化（MokuMoku）

```ts
function isValidShop(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}
function normalizeShopDomain(shop: string): string {
  const normalized = shop.trim().toLowerCase();
  return isValidShop(normalized) ? normalized : "";
}
```

### 1.4 Notion / Slack

- Notion OAuth → D1 `notion_workspace_connections`（access token 平文）
- Slack 同様 D1
- shop は OAuth state の `returnParams.shop` または query から紐付け

---

## 2. D1 に保存している情報のうち Redis へ移す必要があるもの

TTI 目標は **D1 不使用**。MokuMoku D1 相当で Redis へ移すもの:

| D1 内容 | Redis へ | 備考 |
|---------|----------|------|
| Shopify offline session（PoC `shopify_sessions`） | **必須** `shopify:connection:{shop}` または session storage 互換キー | TTI は既に Upstash SessionStorage 実装あり |
| Notion connection（token + data source ids） | **必須** `notion:connection:{shop}` | token は暗号化。MokuMoku は平文なので強化して移植 |
| Slack connection / inbox queue | TTI 範囲外なら不要 | — |
| Prisma 風 `Session` / 旧 `NotionConnection` | 不要（PoC 残骸） | — |

利用回数（ai/ocr/si/delete）は MokuMoku D1 ではなく、TTI 既存 Upstash を継続。

---

## 3. TrackToInventory との差分

| 観点 | MokuMoku Workers UI | TrackToInventory 現状 | 目標 |
|------|---------------------|----------------------|------|
| OAuth 実装 | 手書き authorize/callback | `@shopify/shopify-app-react-router` `authenticate.admin` | TTI のライブラリ経路を維持 |
| offline token 永続化 | **しない**（破棄） | Prisma=`TrackToInventorySession`（既定）/ 任意 Upstash | Upstash のみ |
| リクエストごとの店舗確定 | query `shop` | 多くが query/body `shop_id` を信頼。auth はフォールバック | **session token 検証結果のみ** |
| `unauthenticated.admin(shop)` | なし | graphql / sync-stock / index loader で使用 | 原則禁止（token 検証後の内部 lookup のみ） |
| Notion | D1 平文 | 未実装 | Redis 暗号化 |
| Render | なし | OCR/PDF/files/sync + shared secret | 撤去 |
| Supabase | なし | shipments / storage / session 表 | 撤去 |
| uninstall | PoC 未実装 | session 削除 + shipments/files 削除 | Redis connection + usage 削除設計 |

### 現行 TTI の危険なパターン（要修正対象）

クライアントが `shop_id` だけ付けて Workers API を呼ぶ経路が多く、`authenticate.admin` を意図的にスキップしている（Cloudflare 上の auth hang 回避コメントあり）。

該当例: `api.shipments`, `api.usage`, `api.createShipment`, `api.updateShipment`, `api.delete-shipment`, `api.deleteShipmentFile`, `api.get-file-url`, `api.ai-parse`, `api.check-ocr-limit`, および失敗時に `unauthenticated.admin(shopId)` へ落ちる `api.shopify.graphql` / `api.sync-stock`。

→ **query/body の shop が認可根拠になっている**（TODO の禁止事項に抵触）。

### URL 整合性

- `shopify.app.toml` / deploy-bundle: app・redirect・webhook は Workers (`*.workers.dev`)
- ローカル `.env.local` に旧 Render `SHOPIFY_APP_URL` が残る可能性あり → 本番 Worker シークレットと toml を正とする

---

## 4. そのまま再利用できるコード

### MokuMoku → TTI

- `normalizeShopDomain` / `isValidShop`
- Notion OAuth 開始・callback・`exchangeNotionCode`・databases 一覧・data source 選択 UI フロー
- Notion page/property ヘルパ（Events / Shipments upsert 系）※後続の業務データ移行時
- Gemini PDF `inlineData` parse（Render OCR 置換時）
- `custom-session-storage-smoke` の「session JWT + `authenticate.admin` + custom storage」検証手順

### TTI → 目標構成で継続

- `shopify.server.ts` の `shopifyApp` 初期化（Workers 対応済み）
- `sessionStorage.server.ts` の `UpstashSessionStorage`（キー接頭辞は後で整理可）
- `redis.server.ts` の利用回数・plan キー思想（`userId` 命名は shop domain にリネーム推奨）
- webhook `authenticate.webhook` 骨格（削除先を Redis に向ける）
- billing 系の `authenticate.admin` 必須パターン（良い例）

---

## 5. 修正して再利用すべきコード

| 対象 | 修正内容 |
|------|----------|
| MokuMoku Notion connection 永続化 | D1 平文 → Upstash + AES-GCM 等。Secret は Worker のみ |
| MokuMoku 本番 API の shop 信頼 | **真似しない**。TTI は session token 本線 |
| TTI 全テナント API | `resolveShopFromSessionToken(request)` 必須化。query shop は UI 補助のみ |
| TTI `unauthenticated.admin(shopId)` | クライアント供給 shop からの呼び出しを廃止 |
| TTI フロント fetch | App Bridge `idToken()` → `Authorization: Bearer`（または公式 helper）を付与 |
| TTI `app.jsx` loader | shop をヘッダに出すだけでなく、ページ自体も `authenticate.admin` で守る |
| OCR/sync Render プロキシ | session 確定後の内部処理へ畳む。shared secret 横断 shop 実行を廃止 |
| uninstall webhook | Redis `shopify:*` / `notion:*` / usage・plan の削除範囲を明示実装 |
| `UpstashSessionStorage` | Shopify SessionStorage 互換を維持しつつ、接続メタ用キーを分離（下記 §8） |

---

## 6. Redis 構成で成立するか

**成立する。** 条件付きで TODO 本線は実装可能。

```
Embedded App
  → App Bridge で session token 取得
  → Worker が JWT を検証（署名=API secret, aud=API key, exp/nbf, dest の shop）
  → 検証済み dest から shop domain を確定・正規化
  → Redis を shop domain で lookup
  → offline token / Notion 接続を取得
  → Admin API または Notion API を実行
```

成立根拠:

1. TTI は既に `@shopify/shopify-app-react-router` + CF Workers アダプタ前提
2. MokuMoku smoke が custom storage + `authenticate.admin` 復元を実証
3. Upstash REST は Workers から利用済み（usage / 任意 session）
4. offline token は Redis に置けば Render/Supabase session 表は不要

注意:

- `authenticate.admin` を使う場合、ライブラリが SessionStorage から offline session を読む → **Shopify SessionStorage 互換レイヤは残す**のが最短
- 加えて Notion 用の別キーを持つ（TODO 例の `notion:connection:{shop}`）
- session token 無しのブラウザ fetch はすべて 401 にする（hang 回避のために auth を外す現状方針は捨てる）

---

## 7. セキュリティ上成立しない、または不足している箇所

### 現状で成立しない（要改修）

1. **query/body `shop_id` 認可** — 他店舗データ IDOR
2. **`unauthenticated.admin(clientShop)`** — 任意 shop の offline token で Admin API
3. **Render shared secret** — 秘密を知る者は任意 shop の sync が可能（session が残っていれば）
4. **フロントに Shopify 認証ヘッダ無し** — Worker が店舗を暗号的に確定できない

### 設計上不足しがちな点（実装時に必須）

1. **session token の `dest` と操作対象リソースの shop 一致**（Notion/shipment 行の shop も一致）
2. **暗号化**: Notion/offline token を Redis 平文保存しない（MokuMoku の平文 D1 を踏まない）
3. **鍵ローテーション**: `TOKEN_ENCRYPTION_KEY` を Worker Secret で持ち、Redis に置かない。version フィールド推奨
4. **uninstall 後の残骸**: 現行は Redis usage を消さない → 設計で削除対象に含める
5. **online vs offline**: 画面ユーザー識別は session token、Admin 実行は offline token。混同しない
6. **host を認可に使わない**
7. **Webhook HMAC** は session token 経路と別。uninstall は `authenticate.webhook` の shop のみ信頼

### 「Redis に offline token があれば十分」ではない理由

token があっても、**誰のリクエストか**を session token で証明しなければ、client 指定 shop で他人の token を引き出せる。  
Redis 配置と session token 検証はセットで初めて成立する。

---

## 8. 推奨 Redis キー・値・暗号化・削除設計

### 8.1 キー設計

```
# Shopify 公式 SessionStorage 互換（ライブラリ用・最短経路）
shopify:session:{sessionId}          # Session.toPropertyArray 相当。TTLなし（offline）
shopify:shop-sessions:{shopDomain}   # SET of sessionIds

# アプリ接続メタ（任意・可読性用。SessionStorage と二重でも可だが、初期は SessionStorage のみでも可）
shopify:connection:{shopDomain}
{
  "v": 1,
  "sessionId": "offline_...",
  "scopes": ["read_products", ...],
  "installedAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
# offline token 本体は SessionStorage 側に暗号化して持つ方が単一ソースにしやすい

# Notion
notion:connection:{shopDomain}
{
  "v": 1,
  "ciphertext": "...",          # 下記 plaintext JSON を暗号化
  "iv": "...",
  "updatedAt": "ISO-8601"
}
# plaintext JSON（暗号化前）:
# {
#   accessToken, refreshToken?,
#   workspaceId?,
#   eventsDataSourceId?, shipmentsDataSourceId?,
#   eventsTitle?, shipmentsTitle?
# }

# 利用制限（現行踏襲・命名整理）
usage:plan:{shopDomain}                 # free|basic|pro
usage:ai:{shopDomain}:{YYYY-MM}
usage:ocr:{shopDomain}:{YYYY-MM}
usage:delete:{shopDomain}:{YYYY-MM}
# SI 件数は Notion/将来ストア側カウント。Redis には持たないかキャッシュのみ
```

正規化: 保存・lookup 前に必ず `normalizeShopDomain`。失敗したら 400。

TTL: **原則なし**（uninstall / 再インストールで明示削除・上書き）。  
online session のみライブラリ仕様に合わせ短期 TTL 可。

### 8.2 暗号化

- アルゴリズム: AES-256-GCM（`crypto.subtle`）
- 鍵: Worker Secret `TOKEN_ENCRYPTION_KEY`（32 bytes / base64）。**Redis に置かない**
- 平文に含める: Notion tokens、（SessionStorage を平文のままにしたくない場合）offline access token
- 値に `v`（鍵・フォーマット版）を付け、ローテーション時は dual-read → rewrap

Shopify `UpstashSessionStorage` を当面平文で使う場合でも、Notion token は必ず暗号化する。最終的には offline token も同方式へ寄せる。

### 8.3 Notion token 更新（refresh / re-OAuth）

1. session token で shop 確定
2. 既存 `notion:connection:{shop}` を GET
3. 復号 → refresh または新 token 取得
4. 新 plaintext を暗号化
5. **同一キーへ SET 一発置換**（部分更新で旧 token を残さない）
6. 失敗時は旧値を消さない（GET 後の条件付き書き込みでも可）

### 8.4 `app/uninstalled` 削除範囲

`authenticate.webhook` で得た `shop` を正規化後:

1. `shopify:shop-sessions:{shop}` の全 sessionId を削除 + SET 削除  
2. `shopify:connection:{shop}` 削除  
3. `notion:connection:{shop}` 削除  
4. `usage:plan:{shop}` および `usage:*:{shop}:*` を SCAN/既知プレフィックスで削除  
5. （移行後）その shop の Notion 業務データはユーザー所有のためアプリから一括削除しない。方針をドキュメント化  
6. Supabase/Render 撤去後はそれらの削除コードを削除

Webhook 再送に備え **冪等**にする。

---

## 9. 最小実装順序

Emma 移行なし。書き込みは新キーへの実装時のみ（本設計フェーズでは実施しない）。

1. **共通** `normalizeShopDomain` 導入、用語をコードコメントで固定  
2. **Session を Upstash 既定化**（`SHOPIFY_SESSION_STORAGE=upstash`）。Prisma/Supabase session 依存を切る準備  
3. **フロント** App Bridge session token を全テナント API に付与  
4. **サーバー** テナント API を `authenticate.admin`（または同等 JWT 検証）必須化。query `shop_id` 認可を削除。`unauthenticated.admin(clientShop)` 削除  
5. **Notion OAuth + `notion:connection:{shop}` 暗号化保存**（MokuMoku 移植）  
6. **uninstall webhook** を §8.4 の削除範囲に更新  
7. **Render 依存切断**（OCR→Gemini、sync は Worker 内、files→Notion/R2 等は別 TODO）  
8. **Supabase 切断**（shipments 等の業務データ移行は本 TODO 外だが、session 表参照を零に）  
9. 旧キー・旧環境変数掃除

---

## 10. 各段階の受入テスト

### Stage A — shop 正規化
- [ ] 有効 domain のみ通り、大文字混在は lower 化
- [ ] `sec12` のような非 myshopify は拒否

### Stage B — Upstash session
- [ ] 新規インストールで `offline_{shop}` が Redis に保存される
- [ ] Supabase `TrackToInventorySession` を読まなくても sync/Admin 相当が動く（Worker 内）
- [ ] 秘密・token がログに出ない

### Stage C — session token 本線
- [ ] Bearer 無しの `/api/shipments` 等は 401
- [ ] 店舗 A の token で店舗 B の `shop_id` を付けても **A のみ**操作（B データ 403/無視）
- [ ] `host` 改変だけでは他店にならない
- [ ] URL から shop が消えても、有効 session token があれば API は成功（UI 補助 shop は無くてよい）

### Stage D — Notion connection
- [ ] OAuth 後 `notion:connection:{shop}` が暗号化されて存在
- [ ] Redis 上で plaintext token が読めない
- [ ] 再 OAuth で値が原子的に入れ替わる
- [ ] 他店の Notion 接続を引けない

### Stage E — uninstall
- [ ] uninstall 後、当該 shop の shopify/notion/usage キーが消える
- [ ] 再送でもエラーにならない
- [ ] 他店キーが残る

### Stage F — 回帰
- [ ] billing / products など既存 `authenticate.admin` 経路が維持
- [ ] webhook HMAC 失敗は 401/403
- [ ] Emma 向け特別処理がコードに存在しない

---

## 結論（設計判断）

1. **MokuMoku 本番 UI の「query shop 信頼」は TTI 目標に使わない。**  
2. **再利用するのは Notion OAuth・正規化・（smoke の）session token + custom storage パターン。**  
3. **TTI は既にある `shopifyApp` / `authenticate.admin` / Upstash SessionStorage を本線にし、API の shop_id 認可を撤去するのが最短。**  
4. **Redis 構成は成立する。成立条件は「session token 検証 → 正規化 shop → Redis lookup」の固定であり、Redis 移行だけでは不十分。**  
5. **Emma 個別移行は不要。**

次の実装着手点（別 TODO）: Stage B+C（Upstash session 既定化 + 全 API の session token 必須化）。
