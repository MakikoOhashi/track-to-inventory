-- Stage I: inventory sync ledger for re-run-safe DELTA sync
-- Apply before deploying Workers code that requires this table/RPC.

CREATE TABLE IF NOT EXISTS inventory_sync_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id text NOT NULL,
  si_number text NOT NULL,
  item_key text NOT NULL,
  variant_id text NOT NULL,
  inventory_item_id text,
  location_id text,
  delta_quantity numeric NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'pending',
      'processing',
      'succeeded',
      'failed_retryable',
      'failed_terminal',
      'ambiguous'
    )
  ),
  attempt_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  shopify_adjustment_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_sync_ledger_unique_claim
    UNIQUE (shop_id, si_number, item_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS inventory_sync_ledger_shop_si_idx
  ON inventory_sync_ledger (shop_id, si_number);

CREATE INDEX IF NOT EXISTS inventory_sync_ledger_status_idx
  ON inventory_sync_ledger (status);

CREATE OR REPLACE FUNCTION claim_inventory_sync_ledger(
  p_shop_id text,
  p_si_number text,
  p_item_key text,
  p_variant_id text,
  p_delta_quantity numeric,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  existing inventory_sync_ledger%ROWTYPE;
  claimed inventory_sync_ledger%ROWTYPE;
BEGIN
  INSERT INTO inventory_sync_ledger (
    shop_id,
    si_number,
    item_key,
    variant_id,
    delta_quantity,
    idempotency_key,
    status,
    attempt_count,
    started_at,
    created_at,
    updated_at
  ) VALUES (
    p_shop_id,
    p_si_number,
    p_item_key,
    p_variant_id,
    p_delta_quantity,
    p_idempotency_key,
    'processing',
    1,
    now(),
    now(),
    now()
  )
  ON CONFLICT (shop_id, si_number, item_key, idempotency_key)
  DO NOTHING
  RETURNING * INTO claimed;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'action', 'claimed',
      'row', to_jsonb(claimed)
    );
  END IF;

  SELECT * INTO existing
  FROM inventory_sync_ledger
  WHERE shop_id = p_shop_id
    AND si_number = p_si_number
    AND item_key = p_item_key
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'error', 'error_code', 'NOT_FOUND');
  END IF;

  IF existing.status = 'succeeded' THEN
    RETURN jsonb_build_object('action', 'already_synced', 'row', to_jsonb(existing));
  END IF;

  IF existing.status = 'processing' THEN
    RETURN jsonb_build_object('action', 'in_progress', 'row', to_jsonb(existing));
  END IF;

  IF existing.status = 'ambiguous' THEN
    RETURN jsonb_build_object('action', 'manual_review', 'row', to_jsonb(existing));
  END IF;

  IF existing.status = 'failed_terminal' THEN
    RETURN jsonb_build_object('action', 'terminal', 'row', to_jsonb(existing));
  END IF;

  IF existing.status IN ('failed_retryable', 'pending') THEN
    UPDATE inventory_sync_ledger
    SET
      status = 'processing',
      attempt_count = attempt_count + 1,
      started_at = now(),
      updated_at = now(),
      error_code = NULL,
      error_message = NULL,
      variant_id = p_variant_id,
      delta_quantity = p_delta_quantity
    WHERE id = existing.id
      AND status IN ('failed_retryable', 'pending')
    RETURNING * INTO claimed;

    IF FOUND THEN
      RETURN jsonb_build_object('action', 'claimed', 'row', to_jsonb(claimed));
    END IF;

    SELECT * INTO existing
    FROM inventory_sync_ledger
    WHERE id = existing.id;

    RETURN jsonb_build_object('action', 'in_progress', 'row', to_jsonb(existing));
  END IF;

  RETURN jsonb_build_object('action', 'error', 'error_code', 'UNKNOWN_STATUS', 'row', to_jsonb(existing));
END;
$$;
