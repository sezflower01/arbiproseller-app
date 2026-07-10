-- Add eval mode columns to repricer_assignments for Adaptive Hybrid Repricing
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS eval_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS active_eval_mode text NOT NULL DEFAULT 'smart',
  ADD COLUMN IF NOT EXISTS eval_mode_reason text,
  ADD COLUMN IF NOT EXISTS eval_mode_switched_at timestamptz,
  ADD COLUMN IF NOT EXISTS basic_rule_id uuid REFERENCES public.repricer_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_change_streak integer NOT NULL DEFAULT 0;

-- Add index for quick lookups by eval mode
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_eval_mode
  ON public.repricer_assignments(user_id, eval_mode, active_eval_mode)
  WHERE is_enabled = true;

COMMENT ON COLUMN public.repricer_assignments.eval_mode IS 'User preference: auto | force_smart | force_basic';
COMMENT ON COLUMN public.repricer_assignments.active_eval_mode IS 'Current active mode: smart | basic (set by auto-switch logic)';
COMMENT ON COLUMN public.repricer_assignments.eval_mode_reason IS 'Reason for current active mode (e.g. bb_owner_stable, lost_bb)';
COMMENT ON COLUMN public.repricer_assignments.basic_rule_id IS 'Rule to use when in basic mode (optional override)';
COMMENT ON COLUMN public.repricer_assignments.no_change_streak IS 'Consecutive no_change evaluations for auto-switch logic';