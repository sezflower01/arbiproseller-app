-- Temporary read-only helper to inspect ALL live cron.job state, for the
-- amazon_sync/Reports-API confirmation-pipeline investigation. Dropped in a
-- follow-up migration once the investigation is done. Also drops the
-- narrower debug_peek_cron_jobs() from 20260718210000, which was left behind
-- despite its own comment saying it would be dropped.
DROP FUNCTION IF EXISTS public.debug_peek_cron_jobs();

CREATE OR REPLACE FUNCTION public.debug_peek_all_cron_jobs()
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
  ) ORDER BY jobname)
  FROM cron.job;
$$;
