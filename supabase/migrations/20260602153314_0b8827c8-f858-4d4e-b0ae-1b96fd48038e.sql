ANALYZE public.repricer_price_actions;
ANALYZE public.sales_orders;
ANALYZE public.cron_run_history;
ANALYZE public.inventory;
ANALYZE public.repricer_assignments;
ANALYZE public.repricer_strategic_insights;
ANALYZE public.repricer_operator_actions;
ANALYZE public.repricer_buybox_quality;
ANALYZE public.repricer_action_outcomes;
ANALYZE public.repricer_adaptations_log;
ANALYZE public.repricer_opportunity_scores;
ANALYZE public.repricer_competitor_profiles;
ANALYZE public.repricer_price_actions_daily;

DO $$
DECLARE
  v_result   jsonb;
  v_total    bigint := 0;
  v_rolled   bigint := 0;
  v_iter     int := 0;
  v_remain   bigint;
BEGIN
  LOOP
    v_iter := v_iter + 1;
    v_result := public.prune_repricer_price_actions(60);
    v_total  := v_total + COALESCE((v_result->>'deleted_rows')::bigint, 0);
    v_rolled := v_rolled + COALESCE((v_result->>'rolled_up_rows')::bigint, 0);
    v_remain := COALESCE((v_result->>'remaining_old')::bigint, 0);
    EXIT WHEN v_remain = 0 OR v_iter >= 30;
  END LOOP;
  RAISE NOTICE 'prune: iterations=%, deleted=%, rolled_up=%, remaining_old=%',
    v_iter, v_total, v_rolled, v_remain;
END $$;

ANALYZE public.repricer_price_actions;
ANALYZE public.repricer_price_actions_daily;

SELECT
  (SELECT pg_size_pretty(pg_total_relation_size('public.repricer_price_actions'))) AS price_actions_size_after,
  (SELECT count(*) FROM public.repricer_price_actions)                              AS price_actions_rows_after,
  (SELECT count(*) FROM public.repricer_price_actions_daily)                        AS daily_rollup_rows_after,
  (SELECT count(*) FROM public.repricer_price_actions
     WHERE created_at < now() - interval '60 days')                                 AS old_rows_remaining;