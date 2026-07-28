-- AUTH-1b: encrypted Shopify session tokens and stale rotation protection.
-- Additive only. Existing payload_json rows remain readable as legacy sessions.

ALTER TABLE shopify_sessions ADD COLUMN token_ciphertext TEXT;
ALTER TABLE shopify_sessions ADD COLUMN token_expires_at TEXT;
ALTER TABLE shopify_sessions ADD COLUMN token_fingerprint TEXT;
ALTER TABLE shopify_sessions
  ADD COLUMN token_generation INTEGER NOT NULL DEFAULT 0;

CREATE INDEX shopify_sessions_token_expiry_idx
  ON shopify_sessions (shop, token_expires_at);
