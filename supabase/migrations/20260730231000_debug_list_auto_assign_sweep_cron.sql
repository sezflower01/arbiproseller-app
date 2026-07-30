CREATE OR REPLACE FUNCTION public.debug_list_auto_assign_sweep_cron()
RETURNS TABLE(jobid bigint, jobname text, schedule text, active boolean, command text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jobid, jobname, schedule, active, command
  FROM cron.job
  WHERE command ILIKE '%auto-assign-bulk-intl-sweep%'
  ORDER BY jobname;
$$;
