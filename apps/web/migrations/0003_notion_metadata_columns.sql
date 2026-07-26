-- Stage L8.1: align notion_* tables with runtime NotionConnectionRecord / OAuth payload.
-- Production row count is 0; additive columns only.

PRAGMA foreign_keys = ON;

ALTER TABLE notion_connections ADD COLUMN parent_page_id TEXT;
ALTER TABLE notion_connections ADD COLUMN shipments_data_source_id TEXT;
ALTER TABLE notion_connections ADD COLUMN schema_version INTEGER;
ALTER TABLE notion_connections ADD COLUMN connected_at TEXT;

ALTER TABLE notion_oauth_states ADD COLUMN return_path TEXT;
