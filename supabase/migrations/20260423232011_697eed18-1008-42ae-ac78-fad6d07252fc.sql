-- ============================================================================
-- PHASE 5 REPAIR — Contract A
-- Single transactional migration. Audit-first. Idempotent batch_id.
-- ============================================================================

DO $$
DECLARE
  v_batch_id uuid := gen_random_uuid();
  v_step_a_count int := 0;
  v_step_b_count int := 0;
  v_step_c_count int := 0;
BEGIN
  RAISE NOTICE '[PHASE5] Starting repair batch_id=%', v_batch_id;

  -- ==========================================================================
  -- LEDGER VIEW (per listing): authoritative TOTAL + UNIT cost
  -- Sum across all purchases for that listing.
  -- ==========================================================================
  CREATE TEMP TABLE _ledger ON COMMIT DROP AS
  SELECT
    p.listing_id,
    SUM(p.total_cost)::numeric            AS ledger_total,
    SUM(p.units)::numeric                 AS ledger_units,
    CASE WHEN SUM(p.units) > 0
         THEN (SUM(p.total_cost) / SUM(p.units))::numeric
         ELSE NULL END                    AS ledger_unit_cost
  FROM public.created_listing_purchases p
  GROUP BY p.listing_id
  HAVING SUM(p.units) > 0
     AND SUM(p.total_cost) >= 0;

  CREATE INDEX ON _ledger(listing_id);

  -- ==========================================================================
  -- STEP A — created_listings: amount inflated (cost OK)
  -- ==========================================================================
  CREATE TEMP TABLE _step_a ON COMMIT DROP AS
  SELECT
    cl.id                                  AS row_id,
    cl.user_id,
    cl.asin,
    cl.sku,
    cl.cost                                AS old_cost,
    cl.amount                              AS old_amount,
    cl.units                               AS old_units,
    l.ledger_total,
    l.ledger_units,
    l.ledger_unit_cost,
    l.ledger_unit_cost                     AS new_amount
  FROM public.created_listings cl
  JOIN _ledger l ON l.listing_id = cl.id
  WHERE cl.units IS NOT NULL
    AND cl.units > 0
    -- cost matches ledger total (within 0.5% or 1c tolerance)
    AND ABS(COALESCE(cl.cost, 0) - l.ledger_total)
        <= GREATEST(0.01, ABS(l.ledger_total) * 0.005)
    -- amount is wrong (NOT close to ledger unit cost)
    AND (
      cl.amount IS NULL
      OR ABS(COALESCE(cl.amount, 0) - l.ledger_unit_cost)
         > GREATEST(0.01, ABS(l.ledger_unit_cost) * 0.005)
    )
    -- amount must actually need a change (skip already-correct rows)
    AND COALESCE(cl.amount, -1) IS DISTINCT FROM l.ledger_unit_cost;

  -- Audit FIRST
  INSERT INTO public.cost_repair_audit (
    batch_id, user_id, table_name, row_id, asin, sku,
    repair_category,
    ledger_total, ledger_unit_cost, ledger_units,
    before_snapshot, after_snapshot,
    dry_run, applied, applied_at
  )
  SELECT
    v_batch_id, a.user_id, 'created_listings', a.row_id, a.asin, a.sku,
    'cost_OK_amount_is_costxunits_BUG',
    a.ledger_total, a.ledger_unit_cost, a.ledger_units,
    jsonb_build_object('cost', a.old_cost, 'amount', a.old_amount, 'units', a.old_units),
    jsonb_build_object('cost', a.old_cost, 'amount', a.new_amount, 'units', a.old_units),
    false, true, now()
  FROM _step_a a;

  -- Mutate
  UPDATE public.created_listings cl
  SET amount = a.new_amount,
      updated_at = now()
  FROM _step_a a
  WHERE cl.id = a.row_id;

  GET DIAGNOSTICS v_step_a_count = ROW_COUNT;
  RAISE NOTICE '[PHASE5] Step A updated created_listings rows: %', v_step_a_count;

  -- ==========================================================================
  -- STEP B — inventory: cost holds listing total instead of unit cost
  -- Only when unit_cost_manual = false (or NULL).
  -- ==========================================================================
  CREATE TEMP TABLE _step_b ON COMMIT DROP AS
  WITH listing_unit_cost AS (
    -- One unit cost per (user_id, asin) — most-recently updated listing wins
    SELECT DISTINCT ON (cl.user_id, cl.asin)
      cl.user_id,
      cl.asin,
      l.ledger_unit_cost,
      l.ledger_total,
      l.ledger_units
    FROM public.created_listings cl
    JOIN _ledger l ON l.listing_id = cl.id
    WHERE cl.asin IS NOT NULL AND cl.asin <> ''
    ORDER BY cl.user_id, cl.asin, cl.updated_at DESC
  )
  SELECT
    inv.id                                 AS row_id,
    inv.user_id,
    inv.asin,
    inv.sku,
    inv.cost                               AS old_cost,
    inv.amount                             AS old_amount,
    inv.units                              AS old_units,
    luc.ledger_total,
    luc.ledger_units,
    luc.ledger_unit_cost,
    luc.ledger_unit_cost                                                AS new_cost,
    (luc.ledger_unit_cost * COALESCE(inv.units, 0))::numeric            AS new_amount
  FROM public.inventory inv
  JOIN listing_unit_cost luc
    ON luc.user_id = inv.user_id
   AND luc.asin    = inv.asin
  WHERE COALESCE(inv.unit_cost_manual, false) = false
    -- Current cost is wrong vs ledger unit cost
    AND (
      inv.cost IS NULL
      OR ABS(COALESCE(inv.cost, 0) - luc.ledger_unit_cost)
         > GREATEST(0.01, ABS(luc.ledger_unit_cost) * 0.005)
    )
    -- And the new value actually differs (skip no-op rows)
    AND COALESCE(inv.cost, -1) IS DISTINCT FROM luc.ledger_unit_cost;

  -- Audit FIRST
  INSERT INTO public.cost_repair_audit (
    batch_id, user_id, table_name, row_id, asin, sku,
    repair_category,
    ledger_total, ledger_unit_cost, ledger_units,
    before_snapshot, after_snapshot,
    dry_run, applied, applied_at
  )
  SELECT
    v_batch_id, b.user_id, 'inventory', b.row_id, b.asin, b.sku,
    'inventory_cost_was_listing_total_BUG',
    b.ledger_total, b.ledger_unit_cost, b.ledger_units,
    jsonb_build_object('cost', b.old_cost, 'amount', b.old_amount, 'units', b.old_units),
    jsonb_build_object('cost', b.new_cost, 'amount', b.new_amount, 'units', b.old_units),
    false, true, now()
  FROM _step_b b;

  -- Mutate (cost + amount together, never touch unit_cost_manual=true)
  UPDATE public.inventory inv
  SET cost = b.new_cost,
      amount = b.new_amount,
      updated_at = now()
  FROM _step_b b
  WHERE inv.id = b.row_id
    AND COALESCE(inv.unit_cost_manual, false) = false;

  GET DIAGNOSTICS v_step_b_count = ROW_COUNT;
  RAISE NOTICE '[PHASE5] Step B updated inventory rows: %', v_step_b_count;

  -- ==========================================================================
  -- STEP C — manual_review: listings whose stored values disagree with ledger
  -- Audit only. NO mutation.
  -- ==========================================================================
  CREATE TEMP TABLE _step_c ON COMMIT DROP AS
  SELECT
    cl.id                AS row_id,
    cl.user_id,
    cl.asin,
    cl.sku,
    cl.cost              AS old_cost,
    cl.amount            AS old_amount,
    cl.units             AS old_units,
    l.ledger_total,
    l.ledger_units,
    l.ledger_unit_cost
  FROM public.created_listings cl
  JOIN _ledger l ON l.listing_id = cl.id
  WHERE cl.units IS NOT NULL
    AND cl.units > 0
    -- cost ALSO disagrees with ledger total → can't auto-repair safely
    AND ABS(COALESCE(cl.cost, 0) - l.ledger_total)
        > GREATEST(0.01, ABS(l.ledger_total) * 0.005)
    -- and amount is also off
    AND (
      cl.amount IS NULL
      OR ABS(COALESCE(cl.amount, 0) - l.ledger_unit_cost)
         > GREATEST(0.01, ABS(l.ledger_unit_cost) * 0.005)
    )
    -- Don't double-flag rows already handled by Step A
    AND NOT EXISTS (SELECT 1 FROM _step_a a WHERE a.row_id = cl.id);

  INSERT INTO public.cost_repair_audit (
    batch_id, user_id, table_name, row_id, asin, sku,
    repair_category,
    ledger_total, ledger_unit_cost, ledger_units,
    before_snapshot, after_snapshot,
    dry_run, applied, applied_at, notes
  )
  SELECT
    v_batch_id, c.user_id, 'created_listings', c.row_id, c.asin, c.sku,
    'manual_review_disagrees_with_ledger',
    c.ledger_total, c.ledger_unit_cost, c.ledger_units,
    jsonb_build_object('cost', c.old_cost, 'amount', c.old_amount, 'units', c.old_units),
    NULL,
    false, false, NULL,
    'Stored cost disagrees with ledger total — manual triage required'
  FROM _step_c c;

  GET DIAGNOSTICS v_step_c_count = ROW_COUNT;
  RAISE NOTICE '[PHASE5] Step C manual_review audit rows: %', v_step_c_count;

  RAISE NOTICE '[PHASE5] DONE. batch_id=% A=% B=% C=%',
    v_batch_id, v_step_a_count, v_step_b_count, v_step_c_count;
END $$;