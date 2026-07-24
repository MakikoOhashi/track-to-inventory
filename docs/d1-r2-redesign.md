# TrackToInventory: Cloudflare D1 + R2 再設計（Stage L0）

調査日: 2026-07-24  
方針: **設計・棚卸しのみ**。実データ移行、正本切替、deploy、キー削除、D1/R2 書込、Notion Secrets 設定、在庫 mutation は未実施。

最終目標構成:

| 層 | 役割 |
|----|------|
| **D1** | 業務データ、状態、session、冪等 ledger、期限付きデータ |
| **R2** | PDF / PNG / 添付ファイル本体 |
| **Redis** | 完全撤退（観測期間後） |
| **Supabase DB/Storage** | 段階移行後に撤退 |
| **Notion** | 外部連携先。正本にしない |

---

## 1. 現行データ棚卸し

件数は 2026-07-24 時点の read-only 確認。値・token・ciphertext は記載しない。

### 1.1 Redis（共有 DB `saved-skink`）

総キー: **85**（うち他アプリ 29 + TTI 新/旧）

| ファミリー | 件数 | 型 | TTL | 用途 | 現正本 | 移行先 | 優先 |
|------------|------|----|-----|------|--------|--------|------|
| `tti:invsync:*` | 3 | hash×2, set×1 | なし | ledger + SI index（succeeded×2） | shadow 中は Supabase claim 正本 / Redis 追随 | **D1** `inventory_sync_ledger` | L2–L3 |
| `legacy:invsync:*` | 3 | 同上 | なし | K3.6 残置コピー | 同上 | 廃止（観測後削除） | L9 |
| `tti:shopify:*` | 2 | string+set | なし | offline session + shop index | Redis | **D1** `shopify_sessions` | L4 |
| `legacy:shopify:*` | 2 | 同上 | なし | K3.6 残置 | Redis | 廃止 | L9 |
| `tti:plan:` / legacy | 1+1 | string | なし | 課金 plan キャッシュ | Redis（billing 再取得可） | **D1** `shop_plans` | L5 |
| `tti:ai:` / legacy | 10+10 | string | なし | 月次 AI 回数 | Redis | **D1** `usage_counters` | L5 |
| `tti:ocr:` / legacy | 8+8 | string | なし | 月次 OCR 回数 | Redis | **D1** `usage_counters` | L5 |
| `tti:delete:` / legacy | 4+4 | string | なし | 月次削除回数 | Redis | **D1** `usage_counters` | L5 |
| `tti:notion:*` / legacy | **0** | — | — | connection / oauth / lock | （未使用） | **D1** 対応 table | L6 |
| `ruidaichan:*` | 25 | string | 混在 | **他アプリ** | — | **触らない** | — |
| `wakarumade:*` | 4 | string | 混在 | **他アプリ** | — | **触らない** | — |

原子性: ledger claim は Lua EVAL（現行）。session は単キー GET/SET。counters は INCR（hydrate 付き）。

秘匿: session payload に accessToken、Notion connection に encrypted token（現状 0 件）。

key builder 集約先: `apps/web/app/lib/redisKeys.server.ts`（`tti:` + legacy）。

TTL=-1 の再判定:

| データ | 永続が必要か | D1 方針 |
|--------|--------------|---------|
| ledger succeeded/ambiguous | **必須** | TTL なし |
| offline session | **必須**（ログイン維持） | TTL なし。online のみ `expires_at` |
| plan / ai / ocr / delete | 月次でよいが現行は無期限 | `period_ym` 付き行。旧月は cleanup 可 |
| oauth state / provision lock | **短期** | `expires_at` + scheduled delete |

### 1.2 Supabase Database

| 対象 | 件数 | 用途 | 現正本 | 移行先 | 優先 |
|------|------|------|--------|--------|------|
| `shipments` | 3（shop 2） | SI 業務本体。UNIQUE `(shop_id,si_number)` PK `id` | Supabase | **D1** + items 正規化 | L8 |
| `inventory_sync_ledger` | 2（succeeded） | 冪等 ledger + RPC claim | Supabase（shadow 正本） | **D1** | L2–L3 |
| `TrackToInventorySession` | 1 | Prisma session 残骸 | **非正本**（Redis 正本） | **廃止**（移行しない） | L9 |
| `f1_*` | stores1 / products1 / sales15 / snapshots30 | TTI アプリ未参照 | 別用途残骸 | **移行しない**（別判断） | — |
| RPC `claim_inventory_sync_ledger` | — | 原子 claim | Supabase | D1 SQL/batch へ置換 | L2–L3 |

`shipments` 主要列: `id, shop_id, si_number, status, items(json), supplier_name, transport_type, etd, eta, delayed, clearance_date, arrival_date, memo, is_archived, invoice_url, pl_url, si_url, other_url`。  
ファイル列は現状すべて空（0）。Storage 上の object は DB 非参照の orphan が多い。

### 1.3 Supabase Storage

| 項目 | 内容 |
|------|------|
| bucket | `shipment-files`（private） |
| objects | **4**（いずれも legacy `{si}/…png`。`shops/{shop}/…` 形式 0） |
| DB 参照 | shipments の URL 列はすべて空 → **orphan 4** |
| signed URL | `shipmentFileStorage.server.ts`（upload 7日 / get 24h）。永続禁止方針は既存どおり |
| 削除 | uninstall webhook / deleteShipmentFile |
| 移行先 | **R2** + D1 `file_objects` | L7 |

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

| 列 | 型 | 制約 |
|----|----|------|
| shop_id | TEXT | PK（`*.myshopify.com` 正規化済み） |
| installed_at | TEXT | |
| uninstalled_at | TEXT | NULL |
| plan_cached | TEXT | NULL（denorm 可。正は shop_plans） |

### 3.2 `shipments`

| 列 | 型 | 制約 |
|----|----|------|
| id | TEXT | PK |
| shop_id | TEXT | NOT NULL, FK→shops |
| si_number | TEXT | NOT NULL |
| status | TEXT | NOT NULL |
| supplier_name, transport_type, memo | TEXT | |
| etd, eta, clearance_date, arrival_date | TEXT | date |
| delayed, is_archived | INTEGER | 0/1 |
| version | INTEGER | NOT NULL DEFAULT 1（optimistic concurrency） |

UNIQUE `(shop_id, si_number)`。INDEX `(shop_id)`, `(shop_id, is_archived)`。

### 3.3 `shipment_items`

| 列 | 型 | 制約 |
|----|----|------|
| id | TEXT | PK（= sync_item_id） |
| shipment_id | TEXT | FK→shipments ON DELETE CASCADE |
| shop_id | TEXT | NOT NULL（店舗境界） |
| si_number | TEXT | NOT NULL |
| name, product_code | TEXT | |
| quantity | REAL | |
| unit_price | TEXT | |
| variant_id | TEXT | |
| sort_order | INTEGER | |

UNIQUE `(shipment_id, id)`。INDEX `(shop_id, si_number)`。  
現行 jsonb `items` からの正規化。巨大 JSON を shipment 行に残さない。

### 3.4 `inventory_sync_ledger`（必須安全要件）

| 列 | 型 | 制約 |
|----|----|------|
| id | TEXT | PK |
| shop_id | TEXT | NOT NULL |
| si_number | TEXT | NOT NULL |
| item_key | TEXT | NOT NULL |
| idempotency_key | TEXT | NOT NULL |
| variant_id | TEXT | NOT NULL |
| inventory_item_id, location_id | TEXT | |
| delta_quantity | REAL | NOT NULL |
| status | TEXT | CHECK IN (pending, processing, succeeded, failed_retryable, failed_terminal, ambiguous) |
| attempt_count | INTEGER | NOT NULL DEFAULT 0 |
| claim_token | TEXT | NULL（processing 中のみ） |
| claimed_at / started_at | TEXT | |
| completed_at, succeeded_at, ambiguous_at | TEXT | |
| shopify_adjustment_id | TEXT | |
| error_code, error_message | TEXT | |
| row_version | INTEGER | NOT NULL DEFAULT 1 |

UNIQUE `(shop_id, si_number, item_key, idempotency_key)`。  
INDEX `(shop_id, si_number)`, `(status, claimed_at)`。

**SI index SET は不要**（SQL INDEX で代替）。

### 3.5 `shopify_sessions`

| 列 | 型 | 制約 |
|----|----|------|
| id | TEXT | PK（Shopify session id） |
| shop | TEXT | NOT NULL INDEX |
| payload_json | TEXT | NOT NULL（`Session.toPropertyArray` 互換 JSON） |
| is_online | INTEGER | |
| expires_at | TEXT | NULL（online） |
| access_token_enc | TEXT | NULL（payload 分離する場合。初期は payload 内でも可だが **at-rest 暗号化推奨**） |

INDEX `(shop, expires_at)`。

### 3.6 `shop_plans`

| shop_id PK | plan TEXT | source TEXT | updated_at |

### 3.7 `usage_counters`

| shop_id | kind CHECK(ai\|ocr\|delete) | period_ym TEXT | count INTEGER |  
UNIQUE `(shop_id, kind, period_ym)`。

### 3.8 Notion（接続 0 でも schema 用意）

- `notion_connections` — shop_id PK、workspace_*, bot_id、access_token_enc、db ids、status、last_error  
- `notion_oauth_states` — state PK、shop_id、expires_at（~10分）  
- `notion_provision_locks` — shop_id PK、expires_at、owner_token  

### 3.9 `file_objects`

| 列 | 制約 |
|----|------|
| id | PK |
| shop_id, shipment_id, si_number | NOT NULL / FK |
| kind | CHECK(invoice\|pl\|si\|other) |
| r2_key | UNIQUE NOT NULL |
| content_type, size_bytes, sha256, original_filename | |
| deleted_at | NULL=active |

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

| 結果 | action |
|------|--------|
| A で insert 成功 | `claimed` |
| B status=succeeded | `already_synced`（mutation 0） |
| B status=processing | `in_progress` → stale なら別 UPDATE で ambiguous（reclaim 禁止） |
| B status=ambiguous | `manual_review` |
| B status=failed_terminal | `terminal` |
| C で changes=1 | `claimed` |
| C で changes=0 | 再 SELECT して上記へ |

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

| 方式 | 利点 | 欠点 |
|------|------|------|
| **独自 D1 `SessionStorage`**（推奨） | Redis 完全撤退に一致。現行 `toPropertyArray` payload をそのまま移植可 | 自前保守 |
| 公式 `@shopify/…-sqlite` | 実装済 | ローカルファイル想定。Workers D1 には不向き |
| 公式 `@shopify/…-kv` | CF 定番 | **KV 新規**が目標（D1+R2 のみ）とずれる |

### 切替順序（ログアウト回避）

1. D1 table 作成（L1）  
2. Redis→D1 backfill（offline 優先、TTL なし行）  
3. **read: D1 優先、miss 時 Redis fallback**  
4. **write: D1 のみ**（store/delete は両系から消すときは D1+Redis 両方削除可）  
5. 観測後 Redis session キー読取停止（L9）  

serializer: 現行 `StoredSessionPayload.entries` を `payload_json` に保存し `Session.fromPropertyArray` で復元。online は `expires_at` で無効化。

---

## 6. R2 設計

| 項目 | 設計 |
|------|------|
| bucket | `tti-shipment-files`（private） |
| key | `shops/{shop}/{si_number}/{kind}/{sha256}.{ext}` |
| shop 分離 | path 先頭 shop。API は session shop のみ |
| metadata | D1 `file_objects`（content_type, size, sha256, original_filename, uploaded_at, deleted_at） |
| download | Worker が短命 signed URL（R2 署名）を都度発行。**D1/R2 に URL 永続化しない** |
| 重複防止 | 同一 sha256+kind → skip upload（K5 の checksum 方針と整合） |
| orphan cleanup | `deleted_at` 付き / DB 非参照 R2 を scheduled で列挙削除 |
| 現行 orphan 4 | L7 で「移行しない / quarantine」方針を選択（DB 紐付けなし） |

---

## 7. 期限付きデータ

| データ | expires_at | 取得時 | cleanup |
|--------|------------|--------|---------|
| notion_oauth_states | +10m | 期限切れは無効+削除 | cron 毎時 |
| notion_provision_locks | +90s | NX 相当: INSERT OR 期限切れ上書き | cron |
| online sessions | Shopify expires | load で除外 | cron |
| usage 旧月 | 任意（例: 13ヶ月） | 不要 | 月次 |

cleanup 失敗は業務正本に影響させない（best-effort）。

---

## 8. 段階移行（L1–L9）

| Stage | 内容 | 事前条件 | 完了条件 | 削除禁止 |
|-------|------|----------|----------|----------|
| **L1** | D1 schema + repository 骨格、binding | CF アカウント | migrate empty OK、アプリ未切替 | 本番データ書込なし可 |
| **L2** | ledger D1 shadow（Supabase/Redis 正本のまま） | L1、現行 shadow 理解 | 判定一致ログ | Redis/Supabase ledger 削除禁止 |
| **L3** | ledger D1 正本 + Supabase mirror | L2 一致、mutation 0 受入 | claim/finalize D1、mirror ログ | 旧 ledger 削除禁止。rollback=差分同期必須 |
| **L4** | session → D1 | L1 | ログイン維持、fallback 動作 | Redis session 削除禁止 |
| **L5** | plan/ai/ocr/delete → D1 | L4 安定 | 回数一致 | Redis counter 削除禁止 |
| **L6** | Notion meta → D1 | Secrets+K2 smoke | 接続 0 なら schema のみ | — |
| **L7** | Storage → R2 | file_objects | signed URL 動作、orphan 方針確定 | Supabase objects 削除禁止 |
| **L8** | shipments → D1 | L7（ファイル参照切替後が安全） | CRUD 一致 | Supabase shipments 削除禁止 |
| **L9** | 観測後 Redis/Supabase 互換・旧データ撤去 | L3–L8 安定期間 | 他アプリキー非接触のまま TTI キー削除 | 他アプリ禁止 |

各 Stage: migration dry-run → apply → shadow → 正本 flag → rollback 手順文書化。

**推奨最初の実装: L1 → L2**（ledger が再加算リスク最大。件数も少ない）。

---

## 9. rollback 原則

1. ドメインごとに正本は常に 1 つ  
2. shadow は mutation 権なし  
3. feature flag だけ戻して二重 mutation が起きないこと  
4. ledger 正本切替後の rollback は **D1→旧正本の差分同期必須**  
5. 旧 Redis/Supabase データは観測終了まで削除しない  
6. 共有 Redis の他アプリキーは永久に触らない  

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
