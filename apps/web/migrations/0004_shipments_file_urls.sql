-- Stage L9.1: Supabase shipments file URL columns (additive).
-- Production shipments rows exist only in Supabase today; apply locally/tests first.

PRAGMA foreign_keys = ON;

ALTER TABLE shipments ADD COLUMN invoice_url TEXT;
ALTER TABLE shipments ADD COLUMN pl_url TEXT;
ALTER TABLE shipments ADD COLUMN si_url TEXT;
ALTER TABLE shipments ADD COLUMN other_url TEXT;
