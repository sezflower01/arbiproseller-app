-- Retention status RPC for diagnostics warning logic
CREATE OR REPLACE FUNCTION public.admin_retention_status()
RETURNS TABLE (
  table_name text,
  retention_days int,
  oldest_raw timestamptz,
  rows_over_retention bigint,
  last_prune_at timestamptz,
  last_prune_status text,
  next_prune_at timestamptz,
  prune_active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_oldest timestamptz;
  v_over bigint;
  v_last_at timestamptz;
  v_last_status text;
  v_next timestamptz;
  v_active boolean;
BEGIN
  -- Admin gate
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RETURN;
  END IF;

  -- Only managed retention target at the moment: repricer_price_actions (14d)
  SELECT min(created_at) INTO v_oldest FROM public.repricer_price_actions;
  SELECT count(*) INTO v_over FROM public.repricer_price_actions
    WHERE created_at < now() - interval '14 days';

  SELECT j.active INTO v_active FROM cron.job j
    WHERE j.jobname = 'prune-repricer-price-actions-nightly';

  SELECT d.start_time, d.status
    INTO v_last_at, v_last_status
    FROM cron.job j
    JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.jobname = 'prune-repricer-price-actions-nightly'
    ORDER BY d.start_time DESC
    LIMIT 1;

  -- Schedule is '10 3 * * *' — next 03:10 UTC
  v_next := date_trunc('day', now() at time zone 'UTC')
            + interval '1 day' + interval '3 hours 10 minutes';
  IF v_next - interval '1 day' > now() THEN
    v_next := v_next - interval '1 day';
  END IF;

  RETURN QUERY SELECT
    'repricer_price_actions'::text,
    14,
    v_oldest,
    COALESCE(v_over, 0),
    v_last_at,
    v_last_status,
    v_next,
    COALESCE(v_active, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_retention_status() TO authenticated;