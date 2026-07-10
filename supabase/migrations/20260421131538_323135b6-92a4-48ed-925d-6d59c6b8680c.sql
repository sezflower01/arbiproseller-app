-- =====================================================================
-- PHASE 1: Self-Learning Proof — Outcome Attribution Layer
-- Adds: control groups, time-to-impact, unnecessary undercut tracking,
--       baseline/applied/measured snapshots, and a tuning_lift view.
-- =====================================================================

-- 1. Add columns to existing tuning recommendations for conservative gate
ALTER TABLE public.smart_engine_tuning_recommendations
  ADD COLUMN IF NOT EXISTS admin_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_approved_by uuid,
  ADD COLUMN IF NOT EXISTS admin_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_rejection_reason text;

-- 2. Add columns to tuning actions for control group tracking
ALTER TABLE public.smart_engine_tuning_actions
  ADD COLUMN IF NOT EXISTS scope_asins text[] DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS treatment_asins text[] DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS control_asins text[] DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS control_group_pct numeric NOT NULL DEFAULT 10.0;

-- 3. Add columns to AI reviews for sampling/model audit
ALTER TABLE public.smart_engine_ai_reviews
  ADD COLUMN IF NOT EXISTS selection_reason text,
  ADD COLUMN IF NOT EXISTS model_used text;

-- 4. Add unnecessary-undercut tagging on price actions (per-condition breakdown)
ALTER TABLE public.repricer_price_actions
  ADD COLUMN IF NOT EXISTS was_unnecessary_undercut boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unnecessary_undercut_reason text;
-- enum-style values (text for forward-compat):
-- 'already_lowest_fba' | 'suppressed_bb' | 'low_quality_competitor' | 'no_position_change'

-- =====================================================================
-- 5. CORE: outcome snapshots (baseline / applied / measured)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.smart_engine_outcome_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tuning_action_id uuid NOT NULL REFERENCES public.smart_engine_tuning_actions(id) ON DELETE CASCADE,

  -- Scope
  asin text NOT NULL,
  marketplace text NOT NULL,
  group_label text NOT NULL CHECK (group_label IN ('treatment','control')),
  snapshot_phase text NOT NULL CHECK (snapshot_phase IN ('baseline','applied','measured')),

  -- Window the metrics cover
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  sample_size integer NOT NULL DEFAULT 0,

  -- Outcome metrics
  bb_win_rate_pct numeric,
  price_changes_count integer NOT NULL DEFAULT 0,
  unnecessary_undercut_count integer NOT NULL DEFAULT 0,
  unnecessary_undercut_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  realized_margin_avg numeric,
  oscillation_events integer NOT NULL DEFAULT 0,
  floor_hits integer NOT NULL DEFAULT 0,

  -- Time-to-impact metrics (3 separate, in hours)
  hours_to_bb_regain numeric,
  hours_to_price_stability numeric,
  hours_to_no_further_cuts numeric,

  captured_at timestamptz NOT NULL DEFAULT now(),
  notes text,

  UNIQUE (tuning_action_id, asin, marketplace, snapshot_phase)
);

CREATE INDEX IF NOT EXISTS idx_outcome_snapshots_user
  ON public.smart_engine_outcome_snapshots (user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcome_snapshots_action
  ON public.smart_engine_outcome_snapshots (tuning_action_id, snapshot_phase);
CREATE INDEX IF NOT EXISTS idx_outcome_snapshots_pending
  ON public.smart_engine_outcome_snapshots (snapshot_phase, captured_at);

ALTER TABLE public.smart_engine_outcome_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS: users see own snapshots; admins see all
CREATE POLICY "outcome_snapshots_select_own"
  ON public.smart_engine_outcome_snapshots
  FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "outcome_snapshots_insert_own"
  ON public.smart_engine_outcome_snapshots
  FOR INSERT
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "outcome_snapshots_update_own"
  ON public.smart_engine_outcome_snapshots
  FOR UPDATE
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- =====================================================================
-- 6. LIFT VIEW: pivots snapshots into a per-action lift summary
-- =====================================================================
CREATE OR REPLACE VIEW public.smart_engine_tuning_lift AS
WITH agg AS (
  SELECT
    tuning_action_id,
    user_id,
    group_label,
    snapshot_phase,
    AVG(bb_win_rate_pct) AS bb_win_rate_pct,
    AVG(realized_margin_avg) AS realized_margin_avg,
    SUM(price_changes_count) AS price_changes_count,
    SUM(unnecessary_undercut_count) AS unnecessary_undercut_count,
    SUM(oscillation_events) AS oscillation_events,
    SUM(floor_hits) AS floor_hits,
    AVG(hours_to_bb_regain) AS hours_to_bb_regain,
    AVG(hours_to_price_stability) AS hours_to_price_stability,
    AVG(hours_to_no_further_cuts) AS hours_to_no_further_cuts,
    SUM(sample_size) AS sample_size
  FROM public.smart_engine_outcome_snapshots
  GROUP BY tuning_action_id, user_id, group_label, snapshot_phase
)
SELECT
  ta.id AS tuning_action_id,
  ta.user_id,
  ta.parameter_key,
  ta.old_value,
  ta.new_value,
  ta.applied_at,
  ta.rolled_back_at,
  ta.control_group_pct,
  array_length(ta.treatment_asins, 1) AS treatment_count,
  array_length(ta.control_asins, 1) AS control_count,

  -- Treatment baseline vs measured
  t_base.bb_win_rate_pct AS treatment_bb_win_baseline,
  t_meas.bb_win_rate_pct AS treatment_bb_win_measured,
  t_meas.bb_win_rate_pct - t_base.bb_win_rate_pct AS treatment_bb_win_lift_pct,

  t_base.realized_margin_avg AS treatment_margin_baseline,
  t_meas.realized_margin_avg AS treatment_margin_measured,
  t_meas.realized_margin_avg - t_base.realized_margin_avg AS treatment_margin_lift,

  t_base.unnecessary_undercut_count AS treatment_undercuts_baseline,
  t_meas.unnecessary_undercut_count AS treatment_undercuts_measured,

  t_meas.hours_to_bb_regain AS treatment_hours_to_bb_regain,
  t_meas.hours_to_price_stability AS treatment_hours_to_price_stability,
  t_meas.hours_to_no_further_cuts AS treatment_hours_to_no_further_cuts,

  -- Control baseline vs measured
  c_base.bb_win_rate_pct AS control_bb_win_baseline,
  c_meas.bb_win_rate_pct AS control_bb_win_measured,
  c_meas.bb_win_rate_pct - c_base.bb_win_rate_pct AS control_bb_win_lift_pct,

  c_base.realized_margin_avg AS control_margin_baseline,
  c_meas.realized_margin_avg AS control_margin_measured,
  c_meas.realized_margin_avg - c_base.realized_margin_avg AS control_margin_lift,

  -- Causal lift = (treatment delta) − (control delta)
  (COALESCE(t_meas.bb_win_rate_pct,0) - COALESCE(t_base.bb_win_rate_pct,0))
    - (COALESCE(c_meas.bb_win_rate_pct,0) - COALESCE(c_base.bb_win_rate_pct,0))
    AS causal_bb_win_lift_pct,

  (COALESCE(t_meas.realized_margin_avg,0) - COALESCE(t_base.realized_margin_avg,0))
    - (COALESCE(c_meas.realized_margin_avg,0) - COALESCE(c_base.realized_margin_avg,0))
    AS causal_margin_lift,

  -- Safety
  t_meas.floor_hits AS treatment_floor_hits,
  c_meas.floor_hits AS control_floor_hits

FROM public.smart_engine_tuning_actions ta
LEFT JOIN agg t_base ON t_base.tuning_action_id = ta.id AND t_base.group_label = 'treatment' AND t_base.snapshot_phase = 'baseline'
LEFT JOIN agg t_meas ON t_meas.tuning_action_id = ta.id AND t_meas.group_label = 'treatment' AND t_meas.snapshot_phase = 'measured'
LEFT JOIN agg c_base ON c_base.tuning_action_id = ta.id AND c_base.group_label = 'control'   AND c_base.snapshot_phase = 'baseline'
LEFT JOIN agg c_meas ON c_meas.tuning_action_id = ta.id AND c_meas.group_label = 'control'   AND c_meas.snapshot_phase = 'measured';

-- =====================================================================
-- 7. updated_at trigger on tuning_recommendations (uses existing fn)
-- =====================================================================
DROP TRIGGER IF EXISTS trg_tuning_recs_updated_at ON public.smart_engine_tuning_recommendations;
CREATE TRIGGER trg_tuning_recs_updated_at
  BEFORE UPDATE ON public.smart_engine_tuning_recommendations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();