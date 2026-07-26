# TrackToInventory: Cloudflare D1 + R2 再設計（Stage L0）

調査日: 2026-07-24  
方針: **設計・棚卸しのみ**。実データ移行、正本切替、deploy、キー削除、D1/R2 書込、Notion Secrets 設定、在庫 mutation は未実施。

最終目標構成:

| 層                      | 役割                                                   |
| ----------------------- | ------------------------------------------------------ |
| **D1**                  | 業務データ、状態、session、冪等 ledger、期限付きデータ |
| **R2**                  | PDF / PNG / 添付ファイル本体                           |
| **Redis**               | 完全撤退（観測期間後）                                 |
| **Supabase DB/Storage** | 段階移行後に撤退                                       |
| **Notion**              | 外部連携先。正本にしない                               |

---

## 1. 現行データ棚卸し

件数は 2026-07-24 時点の read-only 確認。値・token・ciphertext は記載しない。

### 1.1 Redis（共有 DB `saved-skink`）

総キー: **85**（うち他アプリ 29 + TTI 新/旧）

| ファミリー              | 件数  | 型            | TTL  | 用途                             | 現正本                                       | 移行先                         | 優先                         |
| ----------------------- | ----- | ------------- | ---- | -------------------------------- | -------------------------------------------- | ------------------------------ | ---------------------------- |
| `tti:invsync:*`         | 3     | hash×2, set×1 | なし | ledger + SI index（succeeded×2） | shadow 中は Supabase claim 正本 / Redis 追随 | **D1** `inventory_sync_ledger` | L2–L3                        |
| `legacy:invsync:*`      | 3     | 同上          | なし | K3.6 残置コピー                  | 同上                                         | 廃止（観測後削除）             | L9                           |
| `tti:shopify:*`         | 2     | string+set    | なし | offline session + shop index     | Redis                                        | **D1** `shopify_sessions`      | L4                           |
| `legacy:shopify:*`      | 2     | 同上          | なし | K3.6 残置                        | Redis                                        | 廃止                           | L9                           |
| `tti:plan:` / legacy    | 1+1   | string        | なし | 課金 plan キャッシュ             | Redis（billing 再取得可）                    | **D1** `shop_plans`            | L5                           |
| `tti:ai:` / legacy      | 10+10 | string        | なし | 月次 AI 回数                     | Redis                                        | **D1** `usage_counters`        | L5                           |
| `tti:ocr:` / legacy     | 8+8   | string        | なし | 月次 OCR 回数                    | Redis                                        | **D1** `usage_counters`        | L5                           |
| `tti:delete:` / legacy  | 4+4   | string        | なし | 月次削除回数                     | Redis                                        | **D1** `usage_counters`        | L5                           |
| `tti:notion:*` / legacy | **0** | —             | —    | connection / oauth / lock        | Redis（コード上正本・データ 0）              | **D1** 対応 table              | L6 / **L8 系列 L8.1 で保留** |
| `ruidaichan:*`          | 25    | string        | 混在 | **他アプリ**                     | —                                            | **触らない**                   | —                            |
| `wakarumade:*`          | 4     | string        | 混在 | **他アプリ**                     | —                                            | **触らない**                   | —                            |

原子性: ledger claim は Lua EVAL（現行）。session は単キー GET/SET。counters は INCR（hydrate 付き）。

秘匿: session payload に accessToken、Notion connection に encrypted token（現状 0 件）。

key builder 集約先: `apps/web/app/lib/redisKeys.server.ts`（`tti:` + legacy）。

TTL=-1 の再判定:

| データ                       | 永続が必要か             | D1 方針                               |
| ---------------------------- | ------------------------ | ------------------------------------- |
| ledger succeeded/ambiguous   | **必須**                 | TTL なし                              |
| offline session              | **必須**（ログイン維持） | TTL なし。online のみ `expires_at`    |
| plan / ai / ocr / delete     | 月次でよいが現行は無期限 | `period_ym` 付き行。旧月は cleanup 可 |
| oauth state / provision lock | **短期**                 | `expires_at` + scheduled delete       |

### 1.2 Supabase Database

| 対象                              | 件数                                        | 用途                                              | 現正本                   | 移行先                   | 優先  |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------- | ------------------------ | ------------------------ | ----- |
| `shipments`                       | 3（shop 2）                                 | SI 業務本体。UNIQUE `(shop_id,si_number)` PK `id` | Supabase                 | **D1** + items 正規化    | L8    |
| `inventory_sync_ledger`           | 2（succeeded）                              | 冪等 ledger + RPC claim                           | Supabase（shadow 正本）  | **D1**                   | L2–L3 |
| `TrackToInventorySession`         | 1                                           | Prisma session 残骸                               | **非正本**（Redis 正本） | **廃止**（移行しない）   | L9    |
| `f1_*`                            | stores1 / products1 / sales15 / snapshots30 | TTI アプリ未参照                                  | 別用途残骸               | **移行しない**（別判断） | —     |
| RPC `claim_inventory_sync_ledger` | —                                           | 原子 claim                                        | Supabase                 | D1 SQL/batch へ置換      | L2–L3 |

`shipments` 主要列: `id, shop_id, si_number, status, items(json), supplier_name, transport_type, etd, eta, delayed, clearance_date, arrival_date, memo, is_archived, invoice_url, pl_url, si_url, other_url`。  
ファイル列は現状すべて空（0）。Storage 上の object は DB 非参照の orphan が多い。

### 1.3 Supabase Storage

| 項目       | 内容                                                                              |
| ---------- | --------------------------------------------------------------------------------- | --- |
| bucket     | `shipment-files`（private）                                                       |
| objects    | **4**（いずれも legacy `{si}/…png`。`shops/{shop}/…` 形式 0）                     |
| DB 参照    | shipments の URL 列はすべて空 → **orphan 4**                                      |
| signed URL | `shipmentFileStorage.server.ts`（upload 7日 / get 24h）。永続禁止方針は既存どおり |
| 削除       | uninstall webhook / deleteShipmentFile                                            |
| 移行先     | **R2** + D1 `file_objects`                                                        | L7  |

### 1.4 Notion（参考）

K2 コードは実装済、Secrets 未設定、接続 0。正本にしない。将来 dual-write しても D1 が業務正本。

---

## 2. 目標構成

```
Worker
  ├─ D1 (tti_db)
  │    shops / shipments / shipment_items / inventory_sync_ledger
  │    shopify_sessions / shop_plans / usage_counters
  │    notion_connections / notion_oauth_states / notion_provision_locks
  │    file_objects / ephemeral_locks（汎用短命）
  └─ R2 (tti-shipment-files)
       shops/{shop}/{si}/{kind}/{sha256}.{ext}
```

Redis / Supabase はドメイン単位で shadow → 正本切替 → 観測 → 撤去。

---

## 3. D1 schema 案

命名: SQLite。UUID は TEXT。時刻は ISO8601 TEXT。  
全業務 table に `migration_source TEXT`, `migration_version TEXT`, `created_at`, `updated_at`。

### 3.1 `shops`

| 列             | 型   | 制約                               |
| -------------- | ---- | ---------------------------------- |
| shop_id        | TEXT | PK（`*.myshopify.com` 正規化済み） |
| installed_at   | TEXT |                                    |
| uninstalled_at | TEXT | NULL                               |
| plan_cached    | TEXT | NULL（denorm 可。正は shop_plans） |

### 3.2 `shipments`

| 列                                     | 型      | 制約                                         |
| -------------------------------------- | ------- | -------------------------------------------- |
| id                                     | TEXT    | PK                                           |
| shop_id                                | TEXT    | NOT NULL, FK→shops                           |
| si_number                              | TEXT    | NOT NULL                                     |
| status                                 | TEXT    | NOT NULL                                     |
| supplier_name, transport_type, memo    | TEXT    |                                              |
| etd, eta, clearance_date, arrival_date | TEXT    | date                                         |
| delayed, is_archived                   | INTEGER | 0/1                                          |
| version                                | INTEGER | NOT NULL DEFAULT 1（optimistic concurrency） |

UNIQUE `(shop_id, si_number)`。INDEX `(shop_id)`, `(shop_id, is_archived)`。

### 3.3 `shipment_items`

| 列                 | 型      | 制約                           |
| ------------------ | ------- | ------------------------------ |
| id                 | TEXT    | PK（= sync_item_id）           |
| shipment_id        | TEXT    | FK→shipments ON DELETE CASCADE |
| shop_id            | TEXT    | NOT NULL（店舗境界）           |
| si_number          | TEXT    | NOT NULL                       |
| name, product_code | TEXT    |                                |
| quantity           | REAL    |                                |
| unit_price         | TEXT    |                                |
| variant_id         | TEXT    |                                |
| sort_order         | INTEGER |                                |

UNIQUE `(shipment_id, id)`。INDEX `(shop_id, si_number)`。  
現行 jsonb `items` からの正規化。巨大 JSON を shipment 行に残さない。

### 3.4 `inventory_sync_ledger`（必須安全要件）

| 列                                       | 型      | 制約                                                                                    |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| id                                       | TEXT    | PK                                                                                      |
| shop_id                                  | TEXT    | NOT NULL                                                                                |
| si_number                                | TEXT    | NOT NULL                                                                                |
| item_key                                 | TEXT    | NOT NULL                                                                                |
| idempotency_key                          | TEXT    | NOT NULL                                                                                |
| variant_id                               | TEXT    | NOT NULL                                                                                |
| inventory_item_id, location_id           | TEXT    |                                                                                         |
| delta_quantity                           | REAL    | NOT NULL                                                                                |
| status                                   | TEXT    | CHECK IN (pending, processing, succeeded, failed_retryable, failed_terminal, ambiguous) |
| attempt_count                            | INTEGER | NOT NULL DEFAULT 0                                                                      |
| claim_token                              | TEXT    | NULL（processing 中のみ）                                                               |
| claimed_at / started_at                  | TEXT    |                                                                                         |
| completed_at, succeeded_at, ambiguous_at | TEXT    |                                                                                         |
| shopify_adjustment_id                    | TEXT    |                                                                                         |
| error_code, error_message                | TEXT    |                                                                                         |
| row_version                              | INTEGER | NOT NULL DEFAULT 1                                                                      |

UNIQUE `(shop_id, si_number, item_key, idempotency_key)`。  
INDEX `(shop_id, si_number)`, `(status, claimed_at)`。

**SI index SET は不要**（SQL INDEX で代替）。

### 3.5 `shopify_sessions`

| 列               | 型      | 制約                                                                             |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| id               | TEXT    | PK（Shopify session id）                                                         |
| shop             | TEXT    | NOT NULL INDEX                                                                   |
| payload_json     | TEXT    | NOT NULL（`Session.toPropertyArray` 互換 JSON）                                  |
| is_online        | INTEGER |                                                                                  |
| expires_at       | TEXT    | NULL（online）                                                                   |
| access_token_enc | TEXT    | NULL（payload 分離する場合。初期は payload 内でも可だが **at-rest 暗号化推奨**） |

INDEX `(shop, expires_at)`。

### 3.6 `shop_plans`

| shop_id PK | plan TEXT | source TEXT | updated_at |

### 3.7 `usage_counters`

| shop_id | kind CHECK(ai\|ocr\|delete) | period_ym TEXT | count INTEGER |  
UNIQUE `(shop_id, kind, period_ym)`。

### 3.8 Notion（接続 0 でも schema 用意）

- `notion_connections` — shop*id PK、workspace*\*, bot_id、access_token_enc、db ids、status、last_error
- `notion_oauth_states` — state PK、shop_id、expires_at（~10分）
- `notion_provision_locks` — shop_id PK、expires_at、owner_token

### 3.9 `file_objects`

| 列                                                  | 制約                          |
| --------------------------------------------------- | ----------------------------- |
| id                                                  | PK                            |
| shop_id, shipment_id, si_number                     | NOT NULL / FK                 |
| kind                                                | CHECK(invoice\|pl\|si\|other) |
| r2_key                                              | UNIQUE NOT NULL               |
| content_type, size_bytes, sha256, original_filename |                               |
| deleted_at                                          | NULL=active                   |

UNIQUE `(shipment_id, kind)`（現行 1 kind 1 file 前提。複数版が必要なら版列追加）。

### 3.10 作らないもの

- 汎用 KV table
- `ai_jobs` / `ocr_jobs`（現行は counter のみ。中間結果を Redis に永続していない）
- `deletion_jobs`（同期削除で足りる。必要なら後置）
- `f1_*` 相当

---

## 4. inventory_sync_ledger — D1 claim / finalize

### 4.1 D1 原子性の範囲

- 対話的 `BEGIN` は Worker から使わない。
- **`db.batch([...])` は一連の statement をトランザクションとして実行**（失敗時ロールバック）。
- JS 介在の read→decide→write はギャップあり。**状態遷移は単一 `UPDATE … WHERE status=… AND claim_token=…` の CAS**で担保する。
- 高競合時の代替: shop 単位 Durable Object（L0 では非採用。必要になったら L3 後に検討）。

### 4.2 Claim（擬似 SQL）

```sql
-- A) 新規行（競合時は何もしない）
INSERT INTO inventory_sync_ledger (
  id, shop_id, si_number, item_key, idempotency_key, variant_id, delta_quantity,
  status, attempt_count, claim_token, claimed_at, started_at, created_at, updated_at,
  migration_source, migration_version
) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?, ?, ?, 'runtime', 'l3-v1')
ON CONFLICT(shop_id, si_number, item_key, idempotency_key) DO NOTHING;

-- B) 現在行を読む
SELECT * FROM inventory_sync_ledger
 WHERE shop_id=? AND si_number=? AND item_key=? AND idempotency_key=?;

-- C) retryable のみ CAS reclaim（stale processing は絶対にここに入れない）
UPDATE inventory_sync_ledger
   SET status='processing',
       attempt_count=attempt_count+1,
       claim_token=?,
       claimed_at=?,
       started_at=?,
       updated_at=?,
       error_code=NULL,
       error_message=NULL,
       row_version=row_version+1
 WHERE shop_id=? AND si_number=? AND item_key=? AND idempotency_key=?
   AND status IN ('pending','failed_retryable')
 RETURNING *;
```

アプリ判定:

| 結果                     | action                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| A で insert 成功         | `claimed`                                                        |
| B status=succeeded       | `already_synced`（mutation 0）                                   |
| B status=processing      | `in_progress` → stale なら別 UPDATE で ambiguous（reclaim 禁止） |
| B status=ambiguous       | `manual_review`                                                  |
| B status=failed_terminal | `terminal`                                                       |
| C で changes=1           | `claimed`                                                        |
| C で changes=0           | 再 SELECT して上記へ                                             |

`batch([A,B])` 後に必要なら C。C と Shopify mutation の間は claim_token 所有者のみ finalize 可。

### 4.3 Finalize

```sql
UPDATE inventory_sync_ledger
   SET status=?, completed_at=?, succeeded_at=?, ambiguous_at=?,
       shopify_adjustment_id=?, inventory_item_id=?, location_id=?,
       error_code=?, error_message=?, claim_token=NULL,
       updated_at=?, row_version=row_version+1
 WHERE id=? AND status='processing' AND claim_token=?
 RETURNING id;
```

changes=0 → OWNER_MISMATCH / 二重 finalize。mutation 成功後にこれが失敗したら **ambiguous** へ別経路（再 claim 禁止）。D1 障害時は mutation を開始しない（claim 失敗 = mutation 0）。

### 4.4 Stale processing

```sql
UPDATE inventory_sync_ledger
   SET status='ambiguous', error_code='STALE_PROCESSING', ...,
       claim_token=NULL, ambiguous_at=?, completed_at=?
 WHERE id=? AND status='processing'
   AND claimed_at <= ?  -- now - 10min（時計差は Worker 側で閾値にバッファ）
 RETURNING *;
```

自動 reclaim なし。

---

## 5. Shopify session 移行設計

### 比較

| 方式                                 | 利点                                                                  | 欠点                                        |
| ------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------- |
| **独自 D1 `SessionStorage`**（推奨） | Redis 完全撤退に一致。現行 `toPropertyArray` payload をそのまま移植可 | 自前保守                                    |
| 公式 `@shopify/…-sqlite`             | 実装済                                                                | ローカルファイル想定。Workers D1 には不向き |
| 公式 `@shopify/…-kv`                 | CF 定番                                                               | **KV 新規**が目標（D1+R2 のみ）とずれる     |

### 切替順序（ログアウト回避）

1. D1 table 作成（L1）
2. Redis→D1 backfill（offline 優先、TTL なし行）
3. **read: D1 優先、miss 時 Redis fallback**
4. **write: D1 のみ**（store/delete は両系から消すときは D1+Redis 両方削除可）
5. 観測後 Redis session キー読取停止（L9）

serializer: 現行 `StoredSessionPayload.entries` を `payload_json` に保存し `Session.fromPropertyArray` で復元。online は `expires_at` で無効化。

---

## 6. R2 設計

| 項目           | 設計                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| bucket         | `tti-shipment-files`（private）                                                             |
| key            | `shops/{shop}/{si_number}/{kind}/{sha256}.{ext}`                                            |
| shop 分離      | path 先頭 shop。API は session shop のみ                                                    |
| metadata       | D1 `file_objects`（content_type, size, sha256, original_filename, uploaded_at, deleted_at） |
| download       | Worker が短命 signed URL（R2 署名）を都度発行。**D1/R2 に URL 永続化しない**                |
| 重複防止       | 同一 sha256+kind → skip upload（K5 の checksum 方針と整合）                                 |
| orphan cleanup | `deleted_at` 付き / DB 非参照 R2 を scheduled で列挙削除                                    |
| 現行 orphan 4  | L7 で「移行しない / quarantine」方針を選択（DB 紐付けなし）                                 |

---

## 7. 期限付きデータ

| データ                 | expires_at         | 取得時                            | cleanup   |
| ---------------------- | ------------------ | --------------------------------- | --------- |
| notion_oauth_states    | +10m               | 期限切れは無効+削除               | cron 毎時 |
| notion_provision_locks | +90s               | NX 相当: INSERT OR 期限切れ上書き | cron      |
| online sessions        | Shopify expires    | load で除外                       | cron      |
| usage 旧月             | 任意（例: 13ヶ月） | 不要                              | 月次      |

cleanup 失敗は業務正本に影響させない（best-effort）。

---

## 8. 段階移行（L1–L9）

| Stage  | 内容                                          | 事前条件                       | 完了条件                              | 削除禁止                                  |
| ------ | --------------------------------------------- | ------------------------------ | ------------------------------------- | ----------------------------------------- |
| **L1** | D1 schema + repository 骨格、binding          | CF アカウント                  | migrate empty OK、アプリ未切替        | 本番データ書込なし可                      |
| **L2** | ledger D1 shadow（Supabase/Redis 正本のまま） | L1、現行 shadow 理解           | 判定一致ログ                          | Redis/Supabase ledger 削除禁止            |
| **L3** | ledger D1 正本 + Supabase mirror              | L2 一致、mutation 0 受入       | claim/finalize D1、mirror ログ        | 旧 ledger 削除禁止。rollback=差分同期必須 |
| **L4** | session → D1                                  | L1                             | ログイン維持、fallback 動作           | Redis session 削除禁止                    |
| **L5** | plan/ai/ocr/delete → D1                       | L4 安定                        | 回数一致                              | Redis counter 削除禁止                    |
| **L6** | Notion meta → D1                              | Secrets+K2 smoke               | 接続 0 なら schema のみ               | —                                         |
| **L7** | Storage → R2                                  | file_objects                   | signed URL 動作、orphan 方針確定      | Supabase objects 削除禁止                 |
| **L8** | shipments → D1                                | L7（ファイル参照切替後が安全） | CRUD 一致                             | Supabase shipments 削除禁止               |
| **L9** | 観測後 Redis/Supabase 互換・旧データ撤去      | L3–L8 安定期間                 | 他アプリキー非接触のまま TTI キー削除 | 他アプリ禁止                              |

各 Stage: migration dry-run → apply → shadow → 正本 flag → rollback 手順文書化。

**推奨最初の実装: L1 → L2**（ledger が再加算リスク最大。件数も少ない）。

### 8.1 Notion metadata 移行（L8 系列）— **L8.1 で保留**

> **表記:** 本節の「L8 系列」は Notion 接続メタデータ用の実行 Stage（L8.0 / L8.1）を指す。上表の **L8 = shipments → D1** とは別トラック。

| 実行 Stage | 内容                                                  | 状態                      |
| ---------- | ----------------------------------------------------- | ------------------------- |
| **L8.0**   | Notion 関連 Redis 依存の read-only 調査               | ✅ 完了                   |
| **L8.1**   | D1 repository + `0003` migration（local）+ 競合テスト | ✅ 完了（**ここで停止**） |
| L8.2+      | 本番 cutover / shadow / OAuth 実接続                  | ⏸ **未着手・保留**        |

**保留理由（2026-07-26）**

- Notion 連携は **ユーザー向け機能として未実装**（UI・OAuth フローはコード上存在するが本番利用 0）
- 本番 Redis `tti:notion:*` / legacy `notion:*` = **0 キー**、D1 Notion 表 = **0 行**
- 稼働中機能（inventory sync ledger・session・usage・shipments）の移行を優先

**保留中の扱い（変更しない）**

| 対象                                          | 方針                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| `app/lib/d1/notionMetadata.server.ts`         | **保持**（将来の Notion 連携基盤）                       |
| `migrations/0003_notion_metadata_columns.sql` | **local / test のみ apply**。**本番 D1 へ apply しない** |
| `app/lib/notionConnection.server.ts`          | **Redis 正本のまま**（ランタイム未接続）                 |
| Redis Notion キー builder / `UPSTASH_*` env   | **削除しない**（ledger 等が引き続き使用）                |

**再開条件**

1. Notion 連携を **ユーザー向け機能として実装する Stage** が開始されたとき
2. 本番 Worker Secrets に `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` / `NOTION_REDIRECT_URI` / `TOKEN_ENCRYPTION_KEY` を設定
3. 本番 D1 へ `0003` migration を apply（接続 0 のため backfill 不要）
4. `notionConnection.server.ts` を **D1 repository に直接接続**し、正本を D1 とする

**L8.1 時点で意図的に行わないこと（再開までスキップ）**

- Redis → D1 の本番 cutover
- Redis / D1 shadow 比較
- Redis から D1 への backfill
- 本番 OAuth 実接続確認

**再開時の実装方針:** shadow 経由は必須としない。D1 repository を正本として `notionConnection.server.ts` に直接配線する（Redis Notion 層は観測後 L9 で撤去候補）。

---

### 8.2 Shipments runtime shadow（L9.3）

Supabaseを利用者応答・mutation成功判定の正本として維持し、
`D1_SHIPMENTS_MODE=shadow`時だけD1 read比較と成功後mirrorを行う。
`d1`値は予約済みだがL9.3ではshadow処理もprimary処理も起動しない。

接続経路:

- list: `app._index` loader、`api.shipments`
- get: create重複確認、delete存在確認、`syncStock`のshipment/items読取
- count: `usageGateway`のSI上限確認
- write: create、update、delete、ファイルURL列更新、syncStockの`sync_item_id`補完
- delete-all: `app/uninstalled`でSupabase全削除成功後

比較はshipmentを`si_number`昇順に揃え、空文字をnull、booleanをboolean、
quantityをnumberへ正規化する。itemsは元配列順を保持し、
`sync_item_id / name / quantity / product_code / unit_price / variant_id`を比較する。
ログには値、全文memo、file URL、tokenを含めず、SI番号はSHA-256短縮参照のみを出す。

差分は`missing_in_d1 / extra_in_d1 / field_mismatch / count_mismatch / d1_error`
に分類する。直近のshadow write失敗は`shadow_write_failure`、それ以外の初期差分は
backfill後〜shadow開始前の更新候補として`pre_shadow_change`を記録する。
自動修復・D1→Supabase back-syncは行わない。

shadow writeはSupabase mutation成功後だけ実行し、D1失敗時は
`shipments_d1_shadow_write_error`を記録して正常returnする。
create/updateはshipment単位でitemsをdelete+insertするため再実行で重複・stale itemを残さない。

L9.3bでは全shadow処理を`ExecutionContext.waitUntil`へ登録し、利用者応答では待機しない。
D1 APIに停止機構がないため、下位処理を残したままログだけtimeoutにする独自Promise raceは
使用しない。処理寿命はCloudflare request lifecycleへ委ねる。

2026-07-26 production version
`182af790-96e1-45fe-9e2e-0605257da201`でshadowを有効化。
deploy前remote verifyはSupabase/D1とも3 shipments / 8 items、差分0。
deploy直後の通常list readはmatch、write error 0。mutation経路は未観測。

### 8.3 Shipments read/write mode分離（L9.4a）

- `D1_SHIPMENTS_READ_MODE=supabase|d1`（default/不正値は`supabase`）
- `D1_SHIPMENTS_WRITE_MODE=off|shadow`（不正な明示値は`off`）
- write mode未設定時はlegacy `D1_SHIPMENTS_MODE=shadow|d1`を`shadow`として互換維持
- D1 user-facing readが例外の場合のみSupabaseへfallbackし、専用logを記録
- D1の正常な空結果は正しい結果として扱い、fallbackしない
- rollbackは`D1_SHIPMENTS_READ_MODE=supabase`へ戻すだけ

L9.4a時点のwrite primaryはSupabaseで、D1はshadowのまま。create重複確認、
update/delete対象確認、syncStock、file URL、uninstall、usage/billingのreadは
mutation前提のためSupabaseを維持する。

## 9. rollback 原則

1. ドメインごとに正本は常に 1 つ
2. shadow は mutation 権なし
3. feature flag だけ戻して二重 mutation が起きないこと
4. ledger 正本切替後の rollback は **D1→旧正本の差分同期必須**
5. 旧 Redis/Supabase データは観測終了まで削除しない
6. 共有 Redis の他アプリキーは永久に触らない

### 9.1 inventory_sync_ledger: D1 primary → Supabase へ戻す手順（L7.2b 改訂）

**前提:** 二重 claim / 二重 Shopify mutation を防ぐため、back-sync 中は同期を止める。

| Step | 操作                                                                                                          | 目的                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1    | **在庫同期を一時停止** — sync-stock API をデプロイ/feature ガードで拒否、または運用で「同期ボタン禁止」を明示 | D1→Supabase 整合中の新規 claim / Shopify mutation を遮断                                               |
| 2    | flag を **D1 primary OFF**（`D1_LEDGER_MODE=shadow` または `off`、`isD1LedgerPrimaryEnabled=false`）          | mutation 権を Supabase に戻す準備（まだ Supabase 正本にはしない）                                      |
| 3    | **D1→Supabase back-sync**                                                                                     | 切替期間中に D1 のみ更新された行を Supabase へ反映                                                     |
| 4    | **全件照合**（`updated_at` 境界のみに依存しない）                                                             | idempotency_key 単位で status / attempt_count / claim_token / Shopify refs / timestamps / error を比較 |
| 5    | 照合 **完全一致** を確認後、`INVSYNC_LEDGER_MODE=supabase`（Supabase を正本に復帰）                           | 正本を 1 つに確定                                                                                      |
| 6    | **在庫同期を再開**                                                                                            | 通常運用へ復帰                                                                                         |

**back-sync 抽出（安全マージン）:**

- **推奨:** `inventory_sync_ledger` **全件**を D1 / Supabase 双方から取得し、`idempotency_key` で突合（件数が少ないうちは必須）
- **代替（件数増大時）:** `updated_at >= (cutover_at - 安全マージン)` で候補抽出した後、**必ず全候補を idempotency_key 単位で再照合**。境界付近 1 時間以上のマージンを取る
- **禁止:** `updated_at` 境界だけで「同期済み」と判断して Supabase 正本復帰すること

**back-sync UPSERT 対象列（Supabase）:**

`id, shop_id, si_number, item_key, idempotency_key, variant_id, delta_quantity, status, attempt_count, inventory_item_id, location_id, shopify_adjustment_id, started_at, completed_at, error_code, error_message, updated_at`

**orphan 処理:**

- D1 上 `processing` のまま残った行 → **ambiguous** 化（自動 reclaim 禁止）。Supabase も同 status に揃える
- back-sync 完了前に Supabase 正本へ flag だけ戻さない（二重 mutation リスク）

**検証:**

- `npm run verify:d1:l72` 相当: missing=0, error/state/action 差分=0
- 再開前に `mutation_risk_claims=0` を確認

---

## 10. 最大リスク・不明点

**リスク**

1. ledger 切替時の再加算（二重 claim）
2. session 移行での一斉ログアウト
3. D1 単一ライター特性による ledger 競合（現状件数では低）
4. Storage orphan と path 正規化の取り違え
5. 共有 Redis 誤削除

**不明点**

- Upstash automatic backup のコンソール実値（K3.5 残）
- Notion Secrets / K2 smoke（K3.5 残）
- 本番 D1 リージョン・バックアップ（PITR）方針
- orphan 4 ファイルの業務要否

---

## 11. L0 実施範囲の確認

- コード変更: **なし**（本ドキュメントと TODO 報告のみ）
- deploy / D1・R2 作成 / データ書込: **なし**
- `INVSYNC_LEDGER_MODE=redis` 切替: **なし**
- Redis 旧キー削除: **なし**
