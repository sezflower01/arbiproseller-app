-- TEMPORARY debug helper to inspect the live pg_cron schedule while
-- investigating a shared SP-API budget race between repricer-unified-dispatch
-- and repricer-priority-cron. Will be dropped by a follow-up migration once
-- the investigation is done.
CREATE OR REPLACE FUNCTION public.debug_list_cron_jobs()
 RETURNS TABLE(jobid bigint, jobname text, schedule text, command text, active boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobname;
$function$;
