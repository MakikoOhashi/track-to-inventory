-- Stage J: shipments identity = (shop_id, si_number)
-- Keep existing rows. Do not drop SI-only uniqueness until composite UNIQUE exists.
-- Rollback notes at bottom.

BEGIN;

-- 1) Surrogate primary key column
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE shipments
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE shipments
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN id SET NOT NULL;

-- 2) shop_id / si_number already NOT NULL in production; reinforce
ALTER TABLE shipments
  ALTER COLUMN shop_id SET NOT NULL,
  ALTER COLUMN si_number SET NOT NULL;

-- 3) Composite business unique BEFORE removing SI-only PK
CREATE UNIQUE INDEX IF NOT EXISTS shipments_shop_si_key
  ON shipments (shop_id, si_number);

-- 4) Switch primary key: id (safe with PostgREST / future FKs)
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_pkey;
ALTER TABLE shipments
  ADD CONSTRAINT shipments_pkey PRIMARY KEY (id);

-- 5) Shop lookup index (unique index above already covers shop_id leading column,
--    but keep an explicit btree for clarity / planners)
CREATE INDEX IF NOT EXISTS shipments_shop_id_idx
  ON shipments (shop_id);

COMMIT;

-- Verification (run manually after apply):
-- SELECT conname, contype FROM pg_constraint WHERE conrelid = 'public.shipments'::regclass;
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'shipments';
-- SELECT count(*) FROM shipments;

-- Rollback (only if no cross-shop duplicate si_number):
-- BEGIN;
-- ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_pkey;
-- DROP INDEX IF EXISTS shipments_shop_si_key;
-- DROP INDEX IF EXISTS shipments_shop_id_idx;
-- ALTER TABLE shipments ADD CONSTRAINT shipments_pkey PRIMARY KEY (si_number);
-- ALTER TABLE shipments DROP COLUMN IF EXISTS id;
-- COMMIT;
