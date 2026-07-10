-- =====================================================
-- SMART PROFIT GUARD + AUTO-EXIT/REENTER MIGRATION
-- =====================================================

-- 1) Add new columns to repricer_rules for dynamic ROI and auto-exit settings
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS enable_profit_guard boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS min_roi_percent_base numeric DEFAULT 20,
  ADD COLUMN IF NOT EXISTS min_roi_percent_high_risk numeric DEFAULT 35,
  ADD COLUMN IF NOT EXISTS high_risk_seller_count_threshold integer DEFAULT 8,
  ADD COLUMN IF NOT EXISTS enable_dynamic_roi boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS enable_auto_exit_reenter boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS reenter_buffer_percent numeric DEFAULT 2,
  ADD COLUMN IF NOT EXISTS cooldown_minutes_on_floor integer DEFAULT 360,
  ADD COLUMN IF NOT EXISTS max_drop_per_run_cents integer DEFAULT 30;

-- Add comment for documentation
COMMENT ON COLUMN public.repricer_rules.enable_profit_guard IS 'Master toggle for profit guard system';
COMMENT ON COLUMN public.repricer_rules.min_roi_percent_base IS 'Base minimum ROI % for stable items (default 20%)';
COMMENT ON COLUMN public.repricer_rules.min_roi_percent_high_risk IS 'Higher minimum ROI % for high-risk items with many sellers (default 35%)';
COMMENT ON COLUMN public.repricer_rules.high_risk_seller_count_threshold IS 'Number of sellers above which item is considered high-risk (default 8)';
COMMENT ON COLUMN public.repricer_rules.enable_dynamic_roi IS 'Toggle for dynamic ROI based on seller count';
COMMENT ON COLUMN public.repricer_rules.enable_auto_exit_reenter IS 'Auto-pause when below floor, auto-resume when market recovers';
COMMENT ON COLUMN public.repricer_rules.reenter_buffer_percent IS 'Market must exceed floor by this % to auto-resume (default 2%)';
COMMENT ON COLUMN public.repricer_rules.cooldown_minutes_on_floor IS 'Minutes to wait before auto-recheck when at floor (default 360 = 6 hours)';
COMMENT ON COLUMN public.repricer_rules.max_drop_per_run_cents IS 'Maximum price decrease per scheduler run in cents (default 30 = $0.30)';

-- 2) Add per-assignment status tracking for auto-exit/reenter
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS paused_reason text,
  ADD COLUMN IF NOT EXISTS paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_floor_price_cents integer,
  ADD COLUMN IF NOT EXISTS consecutive_profit_guard_hits integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_resumed_at timestamptz;

-- Add status column values comment
COMMENT ON COLUMN public.repricer_assignments.paused_reason IS 'Reason for pause: profit_guard, rate_limit, manual, etc.';
COMMENT ON COLUMN public.repricer_assignments.paused_until IS 'When this assignment should be checked for auto-resume';
COMMENT ON COLUMN public.repricer_assignments.last_floor_price_cents IS 'Last calculated floor price in cents for re-entry comparison';
COMMENT ON COLUMN public.repricer_assignments.consecutive_profit_guard_hits IS 'Count of consecutive price updates blocked by profit guard';
COMMENT ON COLUMN public.repricer_assignments.auto_resumed_at IS 'Timestamp when assignment was auto-resumed from profit guard pause';

-- 3) Add new action types to price actions for better transparency
-- The repricer_price_actions table already exists, ensure we support new action types via audit
-- No schema change needed - action_type is text field

-- 4) Add floor breakdown tracking to existing price actions
ALTER TABLE public.repricer_price_actions
  ADD COLUMN IF NOT EXISTS effective_floor_cents integer,
  ADD COLUMN IF NOT EXISTS floor_breakdown_json jsonb,
  ADD COLUMN IF NOT EXISTS recommended_action text;

COMMENT ON COLUMN public.repricer_price_actions.effective_floor_cents IS 'The computed effective floor in cents at time of action';
COMMENT ON COLUMN public.repricer_price_actions.floor_breakdown_json IS 'JSON breakdown: { absolute_floor, profit_floor, roi_floor, triggered_by }';
COMMENT ON COLUMN public.repricer_price_actions.recommended_action IS 'Human-readable recommended action for paused items';