-- Add skip-reason tracking columns to repricer_assignments
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS last_evaluation_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_skip_reason text,
  ADD COLUMN IF NOT EXISTS last_skip_lane text,
  ADD COLUMN IF NOT EXISTS last_skip_details text;

-- Create index for coverage SLA queries (finding oldest unchecked per tier)
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_coverage_sla
  ON public.repricer_assignments (user_id, is_enabled, status, marketplace, last_sp_api_check_at ASC NULLS FIRST)
  WHERE is_enabled = true AND status IN ('active', 'needs_attention');