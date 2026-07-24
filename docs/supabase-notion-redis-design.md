# TrackToInventory: Supabase → Notion + Redis 移行設計（Stage K）

調査日: 2026-07-24  
方針: **調査・設計のみ**。本番データ移行、Supabase 削除、Redis 新規契約、Notion schema 作成、binding/Secret 追加、アプリ切替は未実施。  
制約: D1 / R2 へは移行しない。Stage I（再実行安全）・Stage J（shop+SI）の識別規則は変更しない。

---

## 1. Supabase 依存の全件一覧と分類

| 分類 | 意味 |
|------|------|
| **A** | Notion へ移す |
| **B** | Redis（既存 Upstash）へ移す |
| **C** | 移行完了まで一時残置 |
| **D** | 未使用・履歴・削除候補 |
| **E** | 判断保留 |

### 実行コード

| ファイル | 用途 | 分類 |
|----------|------|------|
| `apps/web/app/lib/supabase.server.ts` | Admin client 生成 | C→削除予定 |
| `apps/web/app/lib/shipmentFileStorage.server.ts` | Storage upload / signed URL / ownership | A（原本→Notion）+ C（移行中 dual） |
| `apps/web/app/lib/syncLedger.server.ts` | ledger claim/finalize/list + RPC | B |
| `apps/web/app/lib/syncStock.server.ts` | shipments 読取・items 書戻し・ledger | A（shipment）+ B（ledger） |
| `apps/web/app/lib/redis.server.ts` | SI 件数を `shipments` count | A（Notion count）へ置換 |
| `apps/web/app/routes/api.createShipment.ts` | insert shipments | A |
| `apps/web/app/routes/api.updateShipment.ts` | update shipments | A |
| `apps/web/app/routes/api.delete-shipment.ts` | delete shipments | A |
| `apps/web/app/routes/api.shipments.ts` | list shipments | A |
| `apps/web/app/routes/api.uploadShipmentFile.ts` | → shipmentFileStorage | A |
| `apps/web/app/routes/api.get-file-url.ts` | signed URL | A（Notion 再取得 URL・一時） |
| `apps/web/app/routes/api.deleteShipmentFile.ts` | Storage + DB 列クリア | A |
| `apps/web/app/routes/api.sync-stock.ts` | sync + ledger GET | B + A（所有確認） |
| `apps/web/app/routes/app._index.tsx` loader | shipments SSR | A |
| `apps/web/app/routes/webhooks.app.uninstalled.jsx` | shop の shipments/files 削除 | A + B（ledger 掃除追加要） |
| `apps/web/app/routes/api.test-connection.ts` | DB ping | D |
| `apps/web/app/routes/api.test-storage.ts` | Storage ping | D |
| `apps/web/workers/app.ts` | `SUPABASE_*` / `DATABASE_URL` env 注入 | C→削除予定 |
| `apps/web/package.json` | `@supabase/supabase-js` | C→削除予定 |

### スキーマ / 設定 / 文書

| 対象 | 分類 |
|------|------|
| `apps/web/supabase/migrations/20260724_inventory_sync_ledger.sql` | B（移植元） |
| `apps/web/supabase/migrations/20260724_shipments_shop_si_unique.sql` | A（制約の意味を Notion+アプリ側へ） |
| `apps/web/.env.example` / README の `SUPABASE_*` | C→更新 |
| Worker Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | C |
| `DATABASE_URL`（Prisma / 直接 PG） | D（Session は Upstash。Prisma Session 経路は廃止済） |
| `TrackToInventorySession` 表 | D（正本は Upstash。行は残骸） |
| `f1_*` 表一式 | D（TTI アプリ未参照。別用途残骸） |
| README / StartGuide の Notion **User Guide** リンク | D（業務 DB ではない） |
| Realtime / Edge Functions / Cron / Supabase Auth | D（未使用） |

### Cloudflare

- Bindings: ASSETS + 通常 vars。Supabase は **Secret/env 経由のみ**（KV/D1/R2 バインドなし）。
- 既存 Redis: **Upstash REST**（sessions / plan / ai / ocr / delete）。新規 Redis サービスは不要（契約追加しない）。

---

## 2. DB / Storage 監査結果（read-only）

### public tables（件数 / 概算）

| table | rows | 総サイズ目安 | TTI 本番用途 |
|-------|------|--------------|--------------|
| `shipments` | 3 | ~64 kB | **本番業務** |
| `inventory_sync_ledger` | 2 | ~80 kB | **本番 ledger** |
| `TrackToInventorySession` | 1 | ~48 kB | 残骸（Upstash 正本） |
| `f1_stores` / `f1_products` / `f1_daily_sales` / `f1_inventory_snapshots` / `f1_forecast_*` | 各種 | 小〜248 kB | **アプリ未使用** |

Triggers: なし。RLS: 無効（service role 直叩き）。Views: なし。

### shipments（Stage J 後）

- PK: `id uuid`
- UNIQUE: `(shop_id, si_number)`（`shipments_shop_si_key`）
- NOT NULL: `id`, `shop_id`, `si_number`
- `items` jsonb（`sync_item_id`, `variant_id`, quantity 等）
- ファイル列: `invoice_url`, `pl_url`, `si_url`, `other_url`（現状は path または空。signed URL 永続は非推奨）

shop 別: `luckywifi-0`×2, `demoohashi`×1。

### inventory_sync_ledger（Stage I）

- PK `id`, UNIQUE `(shop_id, si_number, item_key, idempotency_key)`
- CHECK status ∈ pending/processing/succeeded/failed_retryable/failed_terminal/ambiguous
- RPC `claim_inventory_sync_ledger`（INSERT ON CONFLICT + FOR UPDATE）
- 現状: **succeeded × 2**（luckywifi / Sk123-202507）。ambiguous/processing = 0

### Storage `shipment-files`（private）

| 指標 | 値 |
|------|----|
| objects | 4（すべて legacy、**すべて orphan**） |
| 総容量 | ~3.2 MiB |
| 形式 | png×4 |
| 最大 | ~1.1 MiB（すべて ≤20MB → single-part 可） |
| shop-scoped | 0 |
| DB 参照 path | 0（現行 3 shipments の file 列は空） |

orphan paths: `1/invoice.png`, `12345/invoice.png`, `67890/si.png`, `undefined/invoice.png`  
→ 帰属不明。**勝手に削除・移行しない**（E）。移行対象の正本は「DB が指す object」のみ。現状 DB 参照ゼロのため、本番 backfill 対象の原本は実質なし。

異常データの自動修正・削除は未実施。

---

## 3. 責務分類と field 対応表

### 原則

- **Notion**: 人が見る shipment 業務データ + **原本ファイル本体**（File Upload API）
- **Redis**: inventory sync ledger / claim / 冪等 / ambiguous（**実行権の正本**）
- Notion の更新成功を Shopify mutation 実行権にしない
- Shopify `@idempotent` は継続併用
- `item_key` / `idempotency_key` 生成規則は Stage I のまま

### Field mapping（現在 → 移行先 → 形式 → 正本）

| 現在 | 移行先 | 保存形式 | 正本 |
|------|--------|----------|------|
| `shipments.id` | Notion page id（補助）+ Shipment Key | uuid / text | 業務識別は Shipment Key |
| `shop_id` | Notion `Shop ID` | rich_text/title補助 | Notion + 認証 session |
| `si_number` | Notion `SI Number` | rich_title or rich_text | Notion |
| `status`, dates, supplier, memo, transport, delayed, archived | Notion 各 property | select/date/checkbox/text | Notion |
| `items` jsonb | Notion `Items JSON`（初期）または子 relation | json 文字列 / relation | Notion（編集 UI はアプリ） |
| `invoice_url` 等 | Notion Files: Commercial Invoice / Packing List / SI Doc / Other | **files**（file_upload id 添付） | **Notion 添付 file object** |
| Storage object bytes | Notion managed storage | File Upload | Notion |
| signed download URL | 都度 Notion retrieve | 一時 URL | **永続保存しない** |
| ledger 全列 | Redis HASH | 下記 key 設計 | **Redis** |
| claim RPC | Redis Lua / WATCH+MULTI 相当 | atomic script | Redis |
| SI 件数（redis.server） | Notion query count or Redis cache | int | Notion（制限判定は count） |
| Shopify offline session | 既存 Upstash SessionStorage | 現行維持 | Redis（本 Stage 変更なし） |
| `TrackToInventorySession` | — | — | 削除候補 D |
| `f1_*` | — | — | 削除候補 D（別プロダクト） |

---

## 4. Notion データモデル

### 既存構造の再利用可否

- TTI リポジトリ内に **Shipments 用 Notion DB は未実装**（User Guide の公開サイトリンクのみ）。
- MokuMoku は店舗ごと Notion data source（Shipments DB）を OAuth 接続する方式。**接続・OAuth パターンは再利用**、TTI 用プロパティは新規定義が必要。
- 本 Stage では **新規 DB を作成しない**。K2 で店舗（またはアプリ共通）Shipments data source を用意する。

### 一意性

業務キー: **`shop_id + si_number`（Stage J と同じ）**

- `Shipment Key` = 決定的文字列（推奨: `sha256(normalize(shop_id) + "\\n" + si_number)` の hex、または `shop_id::si_number`）
- Notion に複合 UNIQUE は無い → アプリが create 前に `Shipment Key` filter 検索
- 競合: 同一 Key が 1 件超 → `Migration Status=duplicate_conflict` とし作成中止 / 手動解消。page id だけに依存しない。

### 推奨 properties

| Property | 型 | 用途 |
|----------|-----|------|
| Name / SI Number | title | 表示用 SI |
| Shipment Key | rich_text | 一意検索 |
| Shop ID | rich_text | テナント |
| Status | select | 業務 status |
| Supplier / Transport / Memo | rich_text | |
| ETD / ETA / Clearance / Arrival | date | |
| Delayed / Archived | checkbox | |
| Items JSON | rich_text | 当面 jsonb 互換 |
| Packing List | **files** | 原本 |
| Commercial Invoice | **files** | 原本 |
| SI Document | **files** | 原本 |
| Other Files | **files** | 原本 |
| Latest Source | select | app / migration / manual |
| Migration Status | select | pending / mirrored / verified / conflict |
| Content Meta | rich_text | JSON: `{type:{sha256,size,contentType,filename,fileUploadId,attachedAt}}` |
| Updated At | date | アプリ更新時刻 |

書類は URL プロパティにしない。再取得時の download URL は一時（約1時間）で、正本は files 添付。

### 版管理・再アップロード

1. アップロード前に sha256 計算
2. Content Meta の同一 type の sha256 と一致 → **添付スキップ**（重複防止）
3. 異なる → 新 File Upload → files property を **新ファイルのみ**に置換（旧 Notion file はプロパティから外す）
4. 置換成功・retrieve 確認後まで Supabase 原本は残す（移行期）

同名 SI × 異店舗: Shipment Key に shop を含むため分離可能。

---

## 5. 原本の Notion File Upload 設計

### 公式制約（2026 時点 docs）

- Free: 5 MiB/file、Paid: 最大 5 GiB
- ≤20 MiB: `single_part`、>20 MiB: `multi_part`
- Upload 後 **約1時間以内に page へ添付**しないと expire
- Notion が返す download URL は一時 → **永続保存禁止**
- 429 / Retry-After を尊重

現行 Storage 最大 ~1.1 MiB → すべて single-part 想定。アプリ上限 10MB も single-part 内。

### フロー

```
Worker が認証済み upload を受信
  → sha256 / size / content-type 記録（Redis 一時 or メモリ）
  → POST /v1/file_uploads
  → POST .../send （multipart file）
  → status=uploaded 確認
  → shipment page の Files property に file_upload id で添付
  → retrieve page で添付確認
  → Content Meta 更新
  → （移行期）Supabase object は保持
  → 照合完了後の別 Stage で Supabase 削除
```

### 失敗モード

| 失敗点 | 残るもの | 再開 |
|--------|----------|------|
| file_uploads 作成前 | なし / 受信バッファのみ | 再 upload |
| send 後・attach 前 | 孤立 File Upload（1h で expire） | List file uploads で検出、再 attach or 破棄 |
| attach 後 retrieve 失敗 | Notion に付いている可能性 | retrieve 再試行、成功まで Supabase 残す |
| Notion 障害 | Supabase 原本のみ | fail-closed（ユーザーへエラー）。在庫 sync とは独立 |

移行期の Supabase 削除条件: Notion retrieve で files 存在 + sha256 一致（可能な範囲）+ Migration Status=verified。

---

## 6. Redis（Upstash）ledger 設計

### サービス選定

| 候補 | 評価 |
|------|------|
| **既存 Upstash Redis** | **採用推奨**。Workers REST 互換、session/usage と同居。新規契約不要 |
| Cloudflare Redis / 別ベンダー | 不要（勝手に作らない） |

### Key 設計

```
invsync:ledger:{shop}:{si}:{itemKey}:{idempotencyKey}   # HASH（正本レコード）
invsync:si:{shop}:{si}                                  # SET of ledger keys
invsync:stale:processing                                # ZSET score=started_at_ms（任意）
```

HASH fields（現行列と同等）:  
`id, shop_id, si_number, item_key, variant_id, inventory_item_id, location_id, delta_quantity, idempotency_key, status, attempt_count, started_at, completed_at, shopify_adjustment_id, error_code, error_message, created_at, updated_at`

`id` は初回 claim 時に UUID 生成（調査用）。

### Atomic claim（必須）

単純 SET では不可。**Upstash `EVAL` Lua** を推奨。

擬似ロジック（現行 RPC と同義）:

1. key が無ければ HSET status=processing, attempt=1 → `claimed`
2. status=succeeded → `already_synced`
3. processing → `in_progress`（呼び出し側で stale 判定）
4. ambiguous → `manual_review`
5. failed_terminal → `terminal`
6. failed_retryable/pending → CAS で processing に更新できたら `claimed`

代替: `SET claim-lock NX EX` + 個別 GET/SET は TOCTOU が残るため非推奨。

### TTL / persistence

| 状態 | TTL |
|------|-----|
| succeeded | **なし（-1）** |
| ambiguous | **なし** |
| failed_terminal | **なし**（監査） |
| failed_retryable | **なし**（再試行まで保持） |
| processing | **なし**（stale は started_at で検出→ambiguous） |

- eviction policy: **noeviction または volatile-* のみ**（ledger キーに TTL を付けない前提）。Upstash のプラン上限・eviction 設定を K3 前にダッシュボード確認（本 Stage では変更しない）。
- flush / 障害: **fail-closed** — Redis エラー時は Shopify mutation を実行しない。
- backup: Upstash のバックアップ機能を K3 で有効化検討。喪失時は Shopify `@idempotent` 再照会 + 手動 reconcile（自動再加算しない）。
- Shopify `@idempotent` 継続。idempotency_key 生成規則変更なし。

### 容量

現行 2 行。店舗増加でも HASH + SET で小さい。月次の succeeded 圧縮は将来検討（削除はしない）。

---

## 7. Notion ↔ Redis 失敗時設計（分散 TX なし）

### shipment 作成

1. session shop 確定  
2. Notion で Shipment Key 検索（重複なら 409）  
3. Notion page 作成  
4. 失敗 → ユーザーエラー。Redis 不関与

### 原本 upload

1. Notion page 所有確認（shop+SI）  
2. File Upload → attach → verify  
3. （移行期）Supabase にも書く dual-write 可  
4. Notion 成功・Supabase 失敗 → Notion 正本、Supabase は再試行 or 無視（移行後期）  
5. Supabase 成功・Notion 失敗 → Supabase 残しユーザーエラー（削除しない）

### inventory sync

1. Notion/旧 DB から items 取得（所有確認）  
2. **Redis claim が唯一の実行権**  
3. claimed のみ Shopify mutation  
4. Redis を succeeded/failed/ambiguous に更新  
5. Notion の「同期済み」表示更新は **ベストエフォート**。失敗しても mutation 再発行しない  
6. Redis 障害 → mutation しない

### shipment 削除

1. Redis: 当該 shop+SI の ledger keys を列挙し削除（または status 保持方針を文書化）  
2. Notion page 削除 or archived  
3. Notion files は page 削除に追随  
4. 移行期 Supabase row/object 削除  
順序推奨: Redis ledger 整理 → Notion archive → Supabase。途中失敗は再実行可能に（idempotent delete）

### 書類差し替え

Notion files 置換が成功してから Content Meta 更新。失敗時は旧 Meta のまま。

---

## 8. 移行順序（推奨）

### 比較

| 先に移す | 利点 | 欠点 |
|----------|------|------|
| **Ledger → Redis 先** | Stage I 安全性を Supabase RPC 依存から早期切断。行数少。claim を Workers 内完結 | shipment は一時的に Supabase のまま |
| Shipment → Notion 先 | ユーザー可視データが先 | ledger が旧 RPC のまま。二重の運用期間が長い |

**推奨: Ledger（Redis）を先に移す（K3）、その後 shipment+原本を Notion（K5）。**  
理由: 冪等性はビジネスリスク最大。Notion は人間向けで API 遅延・UNIQUE 無しのため lock に使えない。

### 段階

| Stage | 内容 |
|-------|------|
| **K1** | 本調査（完了） |
| **K2** | Notion Shipments schema 準備・OAuth 接続（店舗ごと）※作成は別作業 |
| **K3** | Redis ledger 実装 + 既存 2 行 backfill + claim 切替。Supabase ledger は shadow 残し可 |
| **K4** | dual-read: sync は Redis 正本、不一致をログ |
| **K5** | shipment + 原本を Notion へ backfill（現状 file 参照 0） |
| **K6** | 件数・checksum・status 照合 |
| **K7** | read path を Notion へ |
| **K8** | write path を Notion へ |
| **K9** | Supabase read-only |
| **K10** | 保持期間後に Storage/DB/Secrets 撤去 |

dual-write: shipment は **shadow-read → write 切替**を推奨（二重書込不一致を避ける）。ledger は Redis へ切替後 Supabase へは書かない（単一正本）。

---

## 9. 後続受入項目（抜粋）

- 同一 shop+SI 重複作成防止 / 異店舗同一 SI 区別  
- shipment 全項目一致  
- 書類件数・filename・size・content-type・checksum、Notion で開ける、種別混同なし  
- orphan file_upload 検出  
- 同一ファイル再送で重複 files を増やさない  
- Redis 同時 claim で実行権 1 のみ  
- succeeded / ambiguous 再実行で Shopify mutation 0  
- Redis 障害で mutation 0、Notion 障害でも在庫再加算なし  
- migration 前後件数一致  
- Supabase 停止後も主要経路が動く（K10 前ゲート）

---

## 10. Rollback 案

- **K3 直後**: sync を Supabase RPC ledger に戻す（表を残している間）。Redis ledger キーは残置可  
- **K8 後**: Notion を read-only に戻し Supabase write を再開（dual 期間のバックアップが必要）  
- **K10 後**: DB バックアップからの復元 + Secrets 再投入。Notion 原本はユーザー workspace に残る  

---

## 11. 未決定事項

1. Notion を **店舗ごと user-owned workspace** にするか、アプリ共有親 DB にするか（MokuMoku は店舗ごと接続）  
2. orphan Storage 4 件の扱い（破棄 / 人手归属 / 移行対象外のまま）  
3. `f1_*` と `TrackToInventorySession` 残骸の削除タイミング  
4. Upstash の eviction / backup 設定の最終確認値  
5. Items を Notion relation（明細ページ）にするか JSON のままか  
6. demoohashi の Upstash offline session 未導入（運用）

---

## 12. 参照ファイル

- `apps/web/app/lib/supabase.server.ts`, `shipmentFileStorage.server.ts`, `syncLedger.server.ts`, `syncStock.server.ts`, `redis.server.ts`
- `apps/web/app/routes/api.{create,update,delete-}Shipment*.ts`, `api.shipments.ts`, `api.sync-stock.ts`, `api.uploadShipmentFile.ts`, `api.get-file-url.ts`, `api.deleteShipmentFile.ts`, `webhooks.app.uninstalled.jsx`
- `apps/web/supabase/migrations/*.sql`, `workers/app.ts`, `docs/shop-auth-redis-design.md`
- Notion Docs: File Upload / working with files and media（size・single/multi-part・URL 期限）

## 13. 変更していないこと

コード・本番 DB/Storage/Redis/Notion schema・Worker Secrets・契約を **変更していない**（本ドキュメント作成と TODO 更新のみ）。
