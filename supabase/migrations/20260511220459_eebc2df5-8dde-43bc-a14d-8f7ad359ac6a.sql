
DO $$
DECLARE v_jobid BIGINT;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'nightly-data-cleanup-0330';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'health-alerts-15min';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule(
  'nightly-data-cleanup-0330',
  '30 3 * * *',
  $job$ SELECT public.run_nightly_maintenance(); SELECT pg_sleep(2); VACUUM (ANALYZE) public.repricer_price_actions, public.repricer_ai_decisions, public.repricer_dispatch_metrics, public.repricer_competitor_snapshots, public.repricer_suggestion_log, public.repricer_simulation_items; $job$
);

SELECT cron.schedule(
  'health-alerts-15min',
  '*/15 * * * *',
  $job$ SELECT public.evaluate_health_alerts(); $job$
);
