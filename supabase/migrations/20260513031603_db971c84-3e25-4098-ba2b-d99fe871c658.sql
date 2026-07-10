
-- Phase 6 scale indexes
CREATE INDEX IF NOT EXISTS idx_opp_user_bucket_score
  ON public.repricer_opportunity_scores(user_id, priority_bucket, score DESC);

CREATE INDEX IF NOT EXISTS idx_outcomes_user_label_time
  ON public.repricer_action_outcomes(user_id, outcome_label, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_bbq_user_class
  ON public.repricer_buybox_quality(user_id, classification);

CREATE INDEX IF NOT EXISTS idx_compprof_user_mp_class
  ON public.repricer_competitor_profiles(user_id, marketplace, classification);

CREATE INDEX IF NOT EXISTS idx_insights_user_active_time
  ON public.repricer_strategic_insights(user_id, generated_at DESC)
  WHERE suppressed = false;

CREATE INDEX IF NOT EXISTS idx_adapt_user_type_time
  ON public.repricer_adaptations_log(user_id, adaptation_type, created_at DESC);

-- Phase 3 cron overlap prevention
CREATE TABLE IF NOT EXISTS public.cron_run_locks (
  job_name text PRIMARY KEY,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.cron_run_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages cron locks"
  ON public.cron_run_locks FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.try_acquire_cron_lock(p_job_name text, p_ttl_seconds integer DEFAULT 600)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  -- Clear expired lock if present
  DELETE FROM public.cron_run_locks
   WHERE job_name = p_job_name AND expires_at < v_now;

  BEGIN
    INSERT INTO public.cron_run_locks(job_name, acquired_at, expires_at)
    VALUES (p_job_name, v_now, v_now + make_interval(secs => p_ttl_seconds));
    RETURN true;
  EXCEPTION WHEN unique_violation THEN
    RETURN false;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_cron_lock(p_job_name text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.cron_run_locks WHERE job_name = p_job_name;
$$;
