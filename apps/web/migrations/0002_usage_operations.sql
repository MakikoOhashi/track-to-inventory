-- Stage L5.1: usage operation ledger for atomic reserve / refund.
-- Does not alter shop_plans / usage_counters shape.
-- Apply locally in tests only; production apply is a later Stage.

PRAGMA foreign_keys = ON;

CREATE TABLE usage_operations (
  operation_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'ocr', 'delete')),
  period_ym TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'refunded')),
  migration_source TEXT,
  migration_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX usage_operations_shop_kind_period_idx
  ON usage_operations (shop_id, kind, period_ym, status);
