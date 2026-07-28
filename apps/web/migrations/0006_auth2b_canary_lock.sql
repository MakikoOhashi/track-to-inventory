CREATE TABLE IF NOT EXISTS auth2b_canary_locks (
  lock_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
