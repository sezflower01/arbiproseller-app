-- nightly-data-cleanup-0330 and nightly-vacuum-analyze-0345 were paused on
-- 2026-05-31 as part of an emergency DB-pressure mitigation (migration
-- 20260531162907) along with ~24 other jobs. Most of those were later
-- rescheduled, but these two never were -- repricer_price_actions has grown
-- unbounded (6.9GB+) with zero pruning since. Restoring original
-- schedule/command from migration 20260512192405.

DO $$
DECLARE v_jobid INT;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'nightly-data-cleanup-0330';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'nightly-vacuum-analyze-0345';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule(
  'nightly-data-cleanup-0330',
  '30 3 * * *',
  $$SELECT public.run_nightly_maintenance();$$
);

SELECT cron.schedule(
  'nightly-vacuum-analyze-0345',
  '45 3 * * *',
  $$VACUUM (ANALYZE) public.repricer_price_actions, public.repricer_ai_decisions, public.repricer_dispatch_metrics, public.repricer_competitor_snapshots, public.repricer_suggestion_log, public.repricer_simulation_items;$$
);
