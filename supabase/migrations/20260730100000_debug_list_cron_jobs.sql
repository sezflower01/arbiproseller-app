-- Temporary helper to inspect pg_cron schedules via RPC (cron.job isn't
-- exposed through PostgREST by default). Dropped immediately after use in
-- migration 20260730100500_drop_debug_list_cron_jobs.sql.
CREATE OR REPLACE FUNCTION public.debug_list_cron_jobs()
RETURNS TABLE (jobid bigint, jobname text, schedule text, command text, active boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY schedule;
$$;

GRANT EXECUTE ON FUNCTION public.debug_list_cron_jobs() TO service_role;
