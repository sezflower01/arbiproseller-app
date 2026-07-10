
-- 1. Cron run log
CREATE TABLE IF NOT EXISTS public.smart_engine_cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  status text NOT NULL DEFAULT 'running', -- running | success | error
  actions_scanned integer DEFAULT 0,
  snapshots_inserted integer DEFAULT 0,
  snapshots_skipped integer DEFAULT 0,
  errors_count integer DEFAULT 0,
  error_sample text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smart_engine_cron_runs_started_at
  ON public.smart_engine_cron_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_smart_engine_cron_runs_job_status
  ON public.smart_engine_cron_runs (job_name, status, started_at DESC);

ALTER TABLE public.smart_engine_cron_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins/monitor can read cron runs" ON public.smart_engine_cron_runs;
CREATE POLICY "Admins/monitor can read cron runs"
  ON public.smart_engine_cron_runs FOR SELECT
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'monitor'));

-- (No INSERT/UPDATE policies → only service role can write, which is what we want.)

-- 2. Tuning action enrichment for guardrails
ALTER TABLE public.smart_engine_tuning_actions
  ADD COLUMN IF NOT EXISTS min_sample_size integer,
  ADD COLUMN IF NOT EXISTS is_observational boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS control_assignment_seed text;

COMMENT ON COLUMN public.smart_engine_tuning_actions.is_observational IS
  'TRUE when scope_asins count fell below the minimum-sample threshold so a causal control group could not be created. Dashboards must label these as observational, not causal.';
COMMENT ON COLUMN public.smart_engine_tuning_actions.control_assignment_seed IS
  'The stable salt fed into hash(user_id + tuning_action_id + asin) to assign treatment vs control. Stored for full reproducibility.';

-- 3. Multi-reason undercut tagging
ALTER TABLE public.repricer_price_actions
  ADD COLUMN IF NOT EXISTS unnecessary_undercut_reasons jsonb;

COMMENT ON COLUMN public.repricer_price_actions.unnecessary_undercut_reasons IS
  'JSON array of every matched reason for an unnecessary undercut. The single-enum unnecessary_undercut_reason column holds only the PRIMARY reason. Possible values: already_lowest_fba, suppressed_bb, low_quality_competitor, no_position_change.';

CREATE INDEX IF NOT EXISTS idx_price_actions_unnecessary_undercut
  ON public.repricer_price_actions (user_id, created_at DESC)
  WHERE was_unnecessary_undercut = true;
