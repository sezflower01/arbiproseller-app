-- Temporary read-only helper to inspect live cron.job / cron.job_run_details
-- state for the inventory-refresh-worker throughput investigation. Dropped
-- in a follow-up migration once the investigation is done.
CREATE OR REPLACE FUNCTION public.debug_peek_cron_jobs()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public, cron'
AS $$
  SELECT jsonb_agg(jsonb_build_object(
    'jobid', jobid,
    'jobname', jobname,
    'schedule', schedule,
    'command', command,
    'active', active
  ))
  FROM cron.job
  WHERE jobname ILIKE '%inventory-refresh%' OR jobname ILIKE '%full-inventory%';
$$;
