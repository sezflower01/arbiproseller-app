-- RPC function to clean old cron.job_run_details rows
-- Uses SECURITY DEFINER to access the cron schema from edge functions
CREATE OR REPLACE FUNCTION public.cleanup_cron_history(cutoff_ts timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  DELETE FROM cron.job_run_details
  WHERE end_time < cutoff_ts;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;