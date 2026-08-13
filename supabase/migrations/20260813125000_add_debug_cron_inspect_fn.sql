-- Temporary debug helper to inspect pg_cron job definitions and recent run
-- history from edge functions (PostgREST can't reach the cron schema
-- directly). service_role only.
CREATE OR REPLACE FUNCTION public.debug_cron_jobs()
RETURNS TABLE(jobid bigint, jobname text, schedule text, active boolean, command text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jobid, jobname, schedule, active, command FROM cron.job ORDER BY jobid;
$$;

CREATE OR REPLACE FUNCTION public.debug_cron_run_details(p_jobid bigint, p_limit int DEFAULT 30)
RETURNS TABLE(jobid bigint, runid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jobid, runid, status, start_time, end_time, return_message
  FROM cron.job_run_details
  WHERE jobid = p_jobid
  ORDER BY start_time DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.debug_cron_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debug_cron_run_details(bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.debug_cron_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.debug_cron_run_details(bigint, int) TO service_role;
