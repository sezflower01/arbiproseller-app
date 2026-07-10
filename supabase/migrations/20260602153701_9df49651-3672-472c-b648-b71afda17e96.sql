-- =====================================================================
-- Repricer Price Actions: prune to 14 days raw retention (Option B)
-- Safe maintenance only. No pricing/evaluator/rule/cron/marketplace changes.
-- prune_repricer_price_actions(retention_days) returns JSONB:
--   { cutoff, deleted_rows, remaining_old, rolled_up_rows }
-- =====================================================================

DO $$
DECLARE
  v_before_count   bigint;
  v_before_size    text;
  v_before_oldest  timestamptz;
  v_before_rollup  bigint;

  v_after_count    bigint;
  v_after_size     text;
  v_after_oldest   timestamptz;
  v_after_rollup   bigint;

  v_iter           int := 0;
  v_max_iter       int := 200;
  v_deleted_total  bigint := 0;
  v_rolled_total   bigint := 0;
  v_result         jsonb;
  v_deleted_call   bigint;
  v_rolled_call    bigint;
  v_remaining_old  bigint;
BEGIN
  -- ---------- BEFORE ----------
  SELECT count(*) INTO v_before_count FROM public.repricer_price_actions;
  SELECT pg_size_pretty(pg_total_relation_size('public.repricer_price_actions'))
    INTO v_before_size;
  SELECT min(created_at) INTO v_before_oldest FROM public.repricer_price_actions;
  SELECT count(*) INTO v_before_rollup FROM public.repricer_price_actions_daily;

  RAISE NOTICE '--- BEFORE ---';
  RAISE NOTICE 'rows=%, size=%, oldest=%, rollup_rows=%',
    v_before_count, v_before_size, v_before_oldest, v_before_rollup;

  -- ---------- Prune loop ----------
  LOOP
    v_iter := v_iter + 1;

    SELECT public.prune_repricer_price_actions(14) INTO v_result;

    v_deleted_call  := COALESCE((v_result->>'deleted_rows')::bigint, 0);
    v_rolled_call   := COALESCE((v_result->>'rolled_up_rows')::bigint, 0);
    v_remaining_old := COALESCE((v_result->>'remaining_old')::bigint, 0);

    v_deleted_total := v_deleted_total + v_deleted_call;
    v_rolled_total  := v_rolled_total  + v_rolled_call;

    RAISE NOTICE 'iter % : deleted=% rolled_up=% remaining_old=%',
      v_iter, v_deleted_call, v_rolled_call, v_remaining_old;

    EXIT WHEN v_remaining_old = 0;
    EXIT WHEN v_deleted_call = 0;       -- no progress
    EXIT WHEN v_iter >= v_max_iter;
  END LOOP;

  -- ---------- ANALYZE ----------
  ANALYZE public.repricer_price_actions;
  ANALYZE public.repricer_price_actions_daily;

  -- ---------- AFTER ----------
  SELECT count(*) INTO v_after_count FROM public.repricer_price_actions;
  SELECT pg_size_pretty(pg_total_relation_size('public.repricer_price_actions'))
    INTO v_after_size;
  SELECT min(created_at) INTO v_after_oldest FROM public.repricer_price_actions;
  SELECT count(*) INTO v_after_rollup FROM public.repricer_price_actions_daily;

  RAISE NOTICE '--- AFTER ---';
  RAISE NOTICE 'rows=%, size=%, oldest=%, rollup_rows=%',
    v_after_count, v_after_size, v_after_oldest, v_after_rollup;
  RAISE NOTICE 'TOTAL deleted=% rolled_up=% iterations=%',
    v_deleted_total, v_rolled_total, v_iter;

  RAISE NOTICE '--- DELTA ---';
  RAISE NOTICE 'rows: % -> % (Δ %)',
    v_before_count, v_after_count, v_before_count - v_after_count;
  RAISE NOTICE 'size: % -> %', v_before_size, v_after_size;
  RAISE NOTICE 'rollup: % -> % (Δ +%)',
    v_before_rollup, v_after_rollup, v_after_rollup - v_before_rollup;
END $$;
