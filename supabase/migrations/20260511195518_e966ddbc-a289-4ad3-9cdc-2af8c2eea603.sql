
-- Cleanup audit log
CREATE TABLE IF NOT EXISTS public.data_cleanup_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);

ALTER TABLE public.data_cleanup_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view cleanup runs"
ON public.data_cleanup_runs
FOR SELECT
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Indexes to make prune queries fast (concurrent variant not allowed in tx; plain CREATE)
CREATE INDEX IF NOT EXISTS idx_repricer_price_actions_created_at
  ON public.repricer_price_actions (created_at);
CREATE INDEX IF NOT EXISTS idx_repricer_ai_decisions_created_at
  ON public.repricer_ai_decisions (created_at);
CREATE INDEX IF NOT EXISTS idx_repricer_dispatch_metrics_cycle_started_at
  ON public.repricer_dispatch_metrics (cycle_started_at);
CREATE INDEX IF NOT EXISTS idx_repricer_competitor_snapshots_created_at
  ON public.repricer_competitor_snapshots (created_at);
CREATE INDEX IF NOT EXISTS idx_repricer_suggestion_log_created_at
  ON public.repricer_suggestion_log (created_at);
CREATE INDEX IF NOT EXISTS idx_repricer_setting_changes_created_at
  ON public.repricer_setting_changes (created_at);
CREATE INDEX IF NOT EXISTS idx_repricer_simulation_items_created_at
  ON public.repricer_simulation_items (created_at);
CREATE INDEX IF NOT EXISTS idx_store_scan_ai_verifications_created_at
  ON public.store_scan_ai_verifications (created_at);

-- Main cleanup function
CREATE OR REPLACE FUNCTION public.nightly_data_cleanup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, net
AS $$
DECLARE
  t_start TIMESTAMPTZ := clock_timestamp();
  details JSONB := '{}'::jsonb;
  n BIGINT;
BEGIN
  -- 1. repricer_price_actions: 30 days
  DELETE FROM public.repricer_price_actions WHERE created_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('repricer_price_actions', n);

  -- 2. repricer_ai_decisions: 30 days
  DELETE FROM public.repricer_ai_decisions WHERE created_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('repricer_ai_decisions', n);

  -- 3. repricer_dispatch_metrics: 14 days
  DELETE FROM public.repricer_dispatch_metrics WHERE cycle_started_at < now() - INTERVAL '14 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('repricer_dispatch_metrics', n);

  -- 4. repricer_competitor_snapshots: 7 days
  DELETE FROM public.repricer_competitor_snapshots WHERE created_at < now() - INTERVAL '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('repricer_competitor_snapshots', n);

  -- 5. repricer_suggestion_log: 14 days
  DELETE FROM public.repricer_suggestion_log WHERE created_at < now() - INTERVAL '14 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('repricer_suggestion_log', n);

  -- 6. repricer_setting_changes: 90 days
  DELETE FROM public.repricer_setting_changes WHERE created_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('repricer_setting_changes', n);

  -- 7. repricer_simulation_items: 7 days
  DELETE FROM public.repricer_simulation_items WHERE created_at < now() - INTERVAL '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('repricer_simulation_items', n);

  -- 8. store_scan_ai_verifications: 30 days
  DELETE FROM public.store_scan_ai_verifications WHERE created_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('store_scan_ai_verifications', n);

  -- 9. cron.job_run_details: 3 days
  BEGIN
    DELETE FROM cron.job_run_details WHERE start_time < now() - INTERVAL '3 days';
    GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('cron_job_run_details', n);
  EXCEPTION WHEN OTHERS THEN
    details := details || jsonb_build_object('cron_job_run_details_error', SQLERRM);
  END;

  -- 10. net._http_response: 2 days
  BEGIN
    DELETE FROM net._http_response WHERE created < now() - INTERVAL '2 days';
    GET DIAGNOSTICS n = ROW_COUNT; details := details || jsonb_build_object('net_http_response', n);
  EXCEPTION WHEN OTHERS THEN
    details := details || jsonb_build_object('net_http_response_error', SQLERRM);
  END;

  -- Log success
  INSERT INTO public.data_cleanup_runs(duration_ms, details)
  VALUES (EXTRACT(MILLISECONDS FROM clock_timestamp() - t_start)::int, details);

  RETURN details;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.data_cleanup_runs(duration_ms, details, error)
  VALUES (EXTRACT(MILLISECONDS FROM clock_timestamp() - t_start)::int, details, SQLERRM);
  RAISE;
END;
$$;

-- Schedule nightly at 03:30 UTC (low-traffic window). Unschedule prior version if present.
DO $$
BEGIN
  PERFORM cron.unschedule('nightly-data-cleanup-0330');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'nightly-data-cleanup-0330',
  '30 3 * * *',
  $$ SELECT public.nightly_data_cleanup(); SELECT pg_sleep(2); VACUUM (ANALYZE) public.repricer_price_actions, public.repricer_ai_decisions, public.repricer_dispatch_metrics, public.repricer_competitor_snapshots, public.repricer_suggestion_log; $$
);
