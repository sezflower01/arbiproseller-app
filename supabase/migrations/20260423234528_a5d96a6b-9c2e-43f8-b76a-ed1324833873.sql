DO $$
DECLARE
  v_batch_id uuid := gen_random_uuid();
  v_updated_count int := 0;
  v_audit_count int := 0;
  r RECORD;
  v_before jsonb;
  v_after jsonb;
  v_new_amount numeric;
BEGIN
  -- Iterate over the exact 65-row candidate set
  FOR r IN
    SELECT id, user_id, asin, sku, units, cost, amount
    FROM public.inventory
    WHERE COALESCE(unit_cost_manual, false) = false
      AND units IS NOT NULL AND units > 0
      AND cost IS NOT NULL AND cost > 0
      AND amount IS NOT NULL
      AND ABS(amount - cost) <= GREATEST(0.01, cost * 0.005)
      AND ABS(amount - (cost * units)) > GREATEST(0.01, (cost * units) * 0.005)
  LOOP
    v_new_amount := ROUND((r.cost * r.units)::numeric, 2);

    v_before := jsonb_build_object(
      'cost', r.cost,
      'amount', r.amount,
      'units', r.units,
      'asin', r.asin,
      'sku', r.sku
    );

    v_after := jsonb_build_object(
      'cost', r.cost,
      'amount', v_new_amount,
      'units', r.units,
      'asin', r.asin,
      'sku', r.sku
    );

    -- AUDIT FIRST
    INSERT INTO public.cost_repair_audit (
      user_id, table_name, row_id, asin, sku, batch_id,
      repair_category, dry_run, applied, applied_at,
      before_snapshot, after_snapshot,
      ledger_total, ledger_unit_cost, ledger_units,
      notes
    ) VALUES (
      r.user_id,
      'inventory',
      r.id,
      r.asin,
      r.sku,
      v_batch_id,
      'amount_undervalued_unit_mirror',
      false,
      true,
      now(),
      v_before,
      v_after,
      v_new_amount,
      r.cost,
      r.units,
      'Phase 5b: amount mirrored unit cost; recomputed as cost * units. Cost untouched, manual overrides excluded.'
    );
    v_audit_count := v_audit_count + 1;

    -- THEN MUTATE (cost untouched)
    UPDATE public.inventory
    SET amount = v_new_amount,
        updated_at = now()
    WHERE id = r.id;
    v_updated_count := v_updated_count + 1;
  END LOOP;

  RAISE NOTICE 'Phase 5b complete. Batch=%, updated=%, audit=%',
    v_batch_id, v_updated_count, v_audit_count;
END $$;