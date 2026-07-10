
-- Auto-assign new repricer users to the least-loaded worker shard
CREATE OR REPLACE FUNCTION public.fn_auto_assign_worker_shard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count_a bigint;
  v_count_b bigint;
BEGIN
  -- Only run on INSERT (new user enabling repricer)
  -- or if dispatch_worker_shard was not explicitly set
  IF NEW.dispatch_worker_shard IS NOT NULL AND NEW.dispatch_worker_shard != 'A' THEN
    RETURN NEW;
  END IF;

  -- Count active users per shard
  SELECT COUNT(*) INTO v_count_a
  FROM public.repricer_settings
  WHERE scheduler_enabled = true AND dispatch_worker_shard = 'A';

  SELECT COUNT(*) INTO v_count_b
  FROM public.repricer_settings
  WHERE scheduler_enabled = true AND dispatch_worker_shard = 'B';

  -- Assign to least-loaded shard
  IF v_count_b < v_count_a THEN
    NEW.dispatch_worker_shard := 'B';
  ELSE
    NEW.dispatch_worker_shard := 'A';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger on INSERT only (new repricer settings row)
CREATE TRIGGER trg_auto_assign_worker_shard
  BEFORE INSERT ON public.repricer_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_auto_assign_worker_shard();
