-- Temporary debug helper to inspect the live pg_cron schedule (source of
-- truth, since migration history alone doesn't reliably reconstruct the
-- current state when jobs were also edited outside migrations).
CREATE OR REPLACE FUNCTION public.debug_list_cron_jobs()
RETURNS TABLE (jobid bigint, jobname text, schedule text, command text, active boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jobid, jobname, schedule, command, active
  FROM cron.job
  ORDER BY jobname;
$$;

GRANT EXECUTE ON FUNCTION public.debug_list_cron_jobs() TO service_role;
