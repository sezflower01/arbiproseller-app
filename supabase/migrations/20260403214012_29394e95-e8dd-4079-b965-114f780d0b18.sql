
CREATE OR REPLACE FUNCTION public.fn_auto_assign_worker_shard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_asins_a bigint;
  v_asins_b bigint;
  v_users_a bigint;
  v_users_b bigint;
BEGIN
  -- Skip if explicitly set to non-default shard
  IF NEW.dispatch_worker_shard IS NOT NULL AND NEW.dispatch_worker_shard != 'A' THEN
    RETURN NEW;
  END IF;

  -- Count active ASINs per shard (the real load indicator)
  SELECT COALESCE(COUNT(*), 0) INTO v_asins_a
  FROM public.repricer_assignments a
  INNER JOIN public.repricer_settings s ON s.user_id = a.user_id
  WHERE s.scheduler_enabled = true
    AND s.dispatch_worker_shard = 'A'
    AND a.is_enabled = true;

  SELECT COALESCE(COUNT(*), 0) INTO v_asins_b
  FROM public.repricer_assignments a
  INNER JOIN public.repricer_settings s ON s.user_id = a.user_id
  WHERE s.scheduler_enabled = true
    AND s.dispatch_worker_shard = 'B'
    AND a.is_enabled = true;

  -- Count users per shard (tiebreaker)
  SELECT COUNT(*) INTO v_users_a
  FROM public.repricer_settings
  WHERE scheduler_enabled = true AND dispatch_worker_shard = 'A';

  SELECT COUNT(*) INTO v_users_b
  FROM public.repricer_settings
  WHERE scheduler_enabled = true AND dispatch_worker_shard = 'B';

  -- Assign to shard with fewer active ASINs, then fewer users as tiebreaker
  IF v_asins_b < v_asins_a THEN
    NEW.dispatch_worker_shard := 'B';
  ELSIF v_asins_a < v_asins_b THEN
    NEW.dispatch_worker_shard := 'A';
  ELSIF v_users_b < v_users_a THEN
    NEW.dispatch_worker_shard := 'B';
  ELSE
    NEW.dispatch_worker_shard := 'A';
  END IF;

  RETURN NEW;
END;
$$;
