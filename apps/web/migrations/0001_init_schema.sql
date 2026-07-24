-- Stage L1: TrackToInventory D1 schema (empty target).
-- Timestamps: ISO8601 TEXT (UTC). Booleans: INTEGER 0/1.
-- L0 omitted: ai_jobs/ai_results, ocr_jobs/ocr_results, deletion_jobs
--   (runtime counters only today; no persisted job payloads).
-- Naming: shop_plans / usage_counters (not plans / counters).

PRAGMA foreign_keys = ON;

CREATE TABLE shops (
  shop_id TEXT PRIMARY KEY,
  installed_at TEXT,
  uninstalled_at TEXT,
  plan_cached TEXT,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE shipments (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(shop_id),
  si_number TEXT NOT NULL,
  status TEXT NOT NULL,
  supplier_name TEXT,
  transport_type TEXT,
  memo TEXT,
  etd TEXT,
  eta TEXT,
  clearance_date TEXT,
  arrival_date TEXT,
  delayed INTEGER NOT NULL DEFAULT 0 CHECK (delayed IN (0, 1)),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, si_number)
);

CREATE INDEX shipments_shop_id_idx ON shipments (shop_id);
CREATE INDEX shipments_shop_archived_idx ON shipments (shop_id, is_archived);

CREATE TABLE shipment_items (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL,
  si_number TEXT NOT NULL,
  name TEXT,
  product_code TEXT,
  quantity REAL,
  unit_price TEXT,
  variant_id TEXT,
  sort_order INTEGER,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shipment_id, id)
);

CREATE INDEX shipment_items_shop_si_idx ON shipment_items (shop_id, si_number);

-- started_at / completed_at == mutation_started_at / mutation_completed_at (L0 naming)
CREATE TABLE inventory_sync_ledger (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  si_number TEXT NOT NULL,
  item_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  inventory_item_id TEXT,
  location_id TEXT,
  delta_quantity REAL NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'processing',
      'succeeded',
      'failed_retryable',
      'failed_terminal',
      'ambiguous'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claimed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  succeeded_at TEXT,
  ambiguous_at TEXT,
  shopify_adjustment_id TEXT,
  error_code TEXT,
  error_message TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (idempotency_key),
  UNIQUE (shop_id, si_number, item_key, idempotency_key)
);

CREATE INDEX inventory_sync_ledger_shop_si_idx
  ON inventory_sync_ledger (shop_id, si_number);
CREATE INDEX inventory_sync_ledger_status_claimed_idx
  ON inventory_sync_ledger (status, claimed_at);

CREATE TABLE shopify_sessions (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  is_online INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
  expires_at TEXT,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX shopify_sessions_shop_expires_idx
  ON shopify_sessions (shop, expires_at);

CREATE TABLE shop_plans (
  shop_id TEXT PRIMARY KEY REFERENCES shops(shop_id),
  plan TEXT NOT NULL,
  source TEXT,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_counters (
  shop_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'ocr', 'delete')),
  period_ym TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, kind, period_ym)
);

CREATE TABLE notion_connections (
  shop_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  workspace_name TEXT,
  bot_id TEXT,
  access_token_enc TEXT,
  shipments_database_id TEXT,
  status TEXT,
  last_error TEXT,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notion_oauth_states (
  state TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX notion_oauth_states_expires_idx
  ON notion_oauth_states (expires_at);

CREATE TABLE notion_provision_locks (
  shop_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE file_objects (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  si_number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'pl', 'si', 'other')),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  original_filename TEXT,
  deleted_at TEXT,
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shipment_id, kind)
);

CREATE INDEX file_objects_shop_si_idx ON file_objects (shop_id, si_number);
