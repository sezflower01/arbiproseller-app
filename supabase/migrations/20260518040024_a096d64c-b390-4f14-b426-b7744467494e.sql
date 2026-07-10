ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS last_disabled_reason text,
  ADD COLUMN IF NOT EXISTS last_disabled_by text,
  ADD COLUMN IF NOT EXISTS last_disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_enabled_by text,
  ADD COLUMN IF NOT EXISTS last_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_paused boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_disabled_audit
  ON public.repricer_assignments (user_id, marketplace, is_enabled, last_disabled_by);

COMMENT ON COLUMN public.repricer_assignments.manual_paused IS 'True only when the seller/user intentionally paused this assignment.';
COMMENT ON COLUMN public.repricer_assignments.last_disabled_by IS 'Actor that disabled the assignment: user, system, cleanup, marketplace, unknown.';
COMMENT ON COLUMN public.repricer_assignments.last_disabled_reason IS 'Human-readable reason for the last disable action.';