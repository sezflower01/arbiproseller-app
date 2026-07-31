-- Temporary debug helper: real run history for a named cron job, straight
-- from pg_cron's own audit table.
CREATE OR REPLACE FUNCTION public.debug_cron_run_details(p_jobname text, p_limit int DEFAULT 20)
RETURNS TABLE (runid bigint, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.runid, d.jobid, d.status, d.return_message, d.start_time, d.end_time
  FROM cron.job_run_details d
  JOIN cron.job j ON j.jobid = d.jobid
  WHERE j.jobname = p_jobname
  ORDER BY d.start_time DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.debug_cron_run_details(text, int) TO service_role;
