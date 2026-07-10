DO $$
DECLARE
  v_row_id uuid := '93eb41d9-c682-443f-a671-df42ed7e8208';
  v_batch_id uuid := 'fda5b217-c9fe-4fa6-9942-fc885cd4029e';
  v_user_id uuid;
  v_before jsonb;
  v_after jsonb;
BEGIN
  -- Snapshot BEFORE
  SELECT user_id,
         jsonb_build_object(
           'cost', cost,
           'amount', amount,
           'units', units,
           'asin', asin,
           'sku', sku
         )
    INTO v_user_id, v_before
  FROM public.created_listings
  WHERE id = v_row_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Target listing % not found', v_row_id;
  END IF;

  -- Apply ledger-aligned repair
  UPDATE public.created_listings
  SET cost = 9.99,
      amount = 9.99,
      units = 1,
      updated_at = now()
  WHERE id = v_row_id;

  -- Snapshot AFTER
  SELECT jsonb_build_object(
           'cost', cost,
           'amount', amount,
           'units', units,
           'asin', asin,
           'sku', sku
         )
    INTO v_after
  FROM public.created_listings
  WHERE id = v_row_id;

  -- Audit
  INSERT INTO public.cost_repair_audit (
    user_id, table_name, row_id, asin, sku, batch_id,
    repair_category, dry_run, applied, applied_at,
    before_snapshot, after_snapshot,
    ledger_total, ledger_unit_cost, ledger_units,
    notes
  ) VALUES (
    v_user_id,
    'created_listings',
    v_row_id,
    'B0CJLPXR6V',
    'DRO-P5X-XK83',
    v_batch_id,
    'manual_review_resolved_to_ledger',
    false,
    true,
    now(),
    v_before,
    v_after,
    9.99,
    9.99,
    1,
    'User-approved manual triage: 1 unit on listing, ledger total $9.99 wins over stored $5.50; no intentional override on record.'
  );
END $$;