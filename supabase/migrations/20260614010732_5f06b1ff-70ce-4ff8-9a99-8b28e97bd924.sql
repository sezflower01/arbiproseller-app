
-- Auto-activation audit columns on repricer_assignments so we can pin
-- newly auto-activated rows to the top of the AssignmentsTable + observability.
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS auto_activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_activated_by TEXT,
  ADD COLUMN IF NOT EXISTS auto_activated_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_user_auto_activated
  ON public.repricer_assignments (user_id, auto_activated_at DESC)
  WHERE auto_activated_at IS NOT NULL;

-- Observability table for the per-user cron fan-out.
CREATE TABLE IF NOT EXISTS public.auto_activate_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  candidates INT NOT NULL DEFAULT 0,
  activated INT NOT NULL DEFAULT 0,
  re_enabled INT NOT NULL DEFAULT 0,
  auto_raised INT NOT NULL DEFAULT 0,
  skip_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.auto_activate_runs TO authenticated;
GRANT ALL ON public.auto_activate_runs TO service_role;

ALTER TABLE public.auto_activate_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view their own auto_activate_runs"
  ON public.auto_activate_runs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_auto_activate_runs_user_started
  ON public.auto_activate_runs (user_id, started_at DESC);
