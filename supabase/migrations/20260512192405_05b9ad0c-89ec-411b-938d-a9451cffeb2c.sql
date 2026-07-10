
-- 1. Fix nightly cron: VACUUM cannot run inside a transaction with other statements.
-- Drop the bundled command and replace with run_nightly_maintenance() only.
-- Add a separate cron just for VACUUM ANALYZE (single statement = pg_cron allows it).

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

-- 2. Helper RPCs for the UI: status + manual "Run Now"

CREATE OR REPLACE FUNCTION public.get_nightly_maintenance_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'cron'
AS $$
DECLARE
  v_job RECORD;
  v_last_parent RECORD;
  v_last_cron RECORD;
  v_last_error RECORD;
  v_next_run TIMESTAMPTZ;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin required';
  END IF;

  SELECT jobid, schedule, command, active INTO v_job
  FROM cron.job WHERE jobname = 'nightly-data-cleanup-0330';

  SELECT id, action, status, started_at, finished_at, duration_ms, rows_affected, error_message, params
  INTO v_last_parent
  FROM public.database_maintenance_jobs
  WHERE action IN ('nightly_maintenance', 'manual_nightly_maintenance')
  ORDER BY started_at DESC LIMIT 1;

  SELECT runid, status, start_time, end_time, return_message
  INTO v_last_cron
  FROM cron.job_run_details
  WHERE jobid = v_job.jobid
  ORDER BY start_time DESC LIMIT 1;

  SELECT runid, status, start_time, return_message
  INTO v_last_error
  FROM cron.job_run_details
  WHERE jobid = v_job.jobid AND status = 'failed'
  ORDER BY start_time DESC LIMIT 1;

  -- Naive next-run estimate: next 03:30 UTC
  v_next_run := date_trunc('day', now() AT TIME ZONE 'UTC') + interval '3 hours 30 minutes';
  IF v_next_run <= now() THEN v_next_run := v_next_run + interval '1 day'; END IF;

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'exists', v_job.jobid IS NOT NULL,
      'jobid', v_job.jobid,
      'schedule', v_job.schedule,
      'active', v_job.active
    ),
    'last_parent', CASE WHEN v_last_parent.id IS NULL THEN NULL ELSE
      jsonb_build_object(
        'action', v_last_parent.action,
        'status', v_last_parent.status,
        'started_at', v_last_parent.started_at,
        'finished_at', v_last_parent.finished_at,
        'duration_ms', v_last_parent.duration_ms,
        'rows_affected', v_last_parent.rows_affected,
        'error_message', v_last_parent.error_message,
        'params', v_last_parent.params
      ) END,
    'last_cron_run', CASE WHEN v_last_cron.runid IS NULL THEN NULL ELSE
      jsonb_build_object(
        'runid', v_last_cron.runid,
        'status', v_last_cron.status,
        'start_time', v_last_cron.start_time,
        'end_time', v_last_cron.end_time,
        'return_message', v_last_cron.return_message
      ) END,
    'last_error', CASE WHEN v_last_error.runid IS NULL THEN NULL ELSE
      jsonb_build_object(
        'runid', v_last_error.runid,
        'start_time', v_last_error.start_time,
        'return_message', v_last_error.return_message
      ) END,
    'next_run_estimate', v_next_run,
    'stale', (v_last_parent.finished_at IS NULL OR v_last_parent.finished_at < now() - interval '24 hours')
  );
END $$;

CREATE OR REPLACE FUNCTION public.run_nightly_maintenance_now()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_email TEXT;
  v_result JSONB;
  v_started TIMESTAMPTZ := now();
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin required';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

  v_result := public.run_nightly_maintenance();

  -- Tag the most-recent parent row as a manual run for visibility
  UPDATE public.database_maintenance_jobs
  SET action = 'manual_nightly_maintenance',
      triggered_by_email = COALESCE(v_email, 'admin@manual')
  WHERE action = 'nightly_maintenance'
    AND started_at >= v_started;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.get_nightly_maintenance_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.run_nightly_maintenance_now() TO authenticated;
