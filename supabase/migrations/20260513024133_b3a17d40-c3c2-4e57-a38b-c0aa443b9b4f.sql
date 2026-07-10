-- 1. Action outcomes
CREATE TABLE IF NOT EXISTS public.repricer_action_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL,
  action_id uuid, -- references repricer_price_actions if available
  action_type text, -- reduction | raise | hold | adaptation | operator_approve
  recommended_at timestamptz NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  before_snapshot jsonb DEFAULT '{}'::jsonb,
  after_snapshot jsonb DEFAULT '{}'::jsonb,
  bb_improved boolean,
  sales_improved boolean,
  revenue_delta_usd numeric,
  margin_delta_pct numeric,
  age_improved boolean,
  outcome_label text NOT NULL DEFAULT 'neutral', -- successful | partial | neutral | failed | reversed
  confidence_score numeric DEFAULT 0.5,
  notes text
);
CREATE INDEX IF NOT EXISTS idx_outcomes_user_time ON public.repricer_action_outcomes(user_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_asin ON public.repricer_action_outcomes(user_id, asin, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_label ON public.repricer_action_outcomes(user_id, outcome_label);

ALTER TABLE public.repricer_action_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own outcomes"
  ON public.repricer_action_outcomes FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages outcomes"
  ON public.repricer_action_outcomes FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Per-user automation preferences
CREATE TABLE IF NOT EXISTS public.repricer_user_automation_preferences (
  user_id uuid PRIMARY KEY,
  automation_tier text NOT NULL DEFAULT 'balanced', -- conservative | balanced | aggressive | autonomous
  allow_auto_fix boolean NOT NULL DEFAULT false,
  allow_autonomous_recovery boolean NOT NULL DEFAULT false,
  recovery_speed text NOT NULL DEFAULT 'gradual', -- slow | gradual | fast
  escalation_threshold integer NOT NULL DEFAULT 75, -- opportunity score gate
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.repricer_user_automation_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own automation prefs"
  ON public.repricer_user_automation_preferences FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users insert own automation prefs"
  ON public.repricer_user_automation_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own automation prefs"
  ON public.repricer_user_automation_preferences FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manages automation prefs"
  ON public.repricer_user_automation_preferences FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Extend strategy memory
ALTER TABLE public.repricer_asin_strategy_memory
  ADD COLUMN IF NOT EXISTS personality_profile text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS recent_outcome_score numeric;
CREATE INDEX IF NOT EXISTS idx_mem_personality ON public.repricer_asin_strategy_memory(user_id, personality_profile);