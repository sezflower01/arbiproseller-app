-- 1. Opportunity scores (refreshed hourly)
CREATE TABLE IF NOT EXISTS public.repricer_opportunity_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL,
  sku text,
  score numeric NOT NULL DEFAULT 0,
  priority_bucket text NOT NULL DEFAULT 'routine', -- urgent | high | medium | routine
  factors jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_reason text,
  suggested_action text,
  expected_impact_usd numeric,
  confidence text DEFAULT 'estimated',
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, asin, marketplace)
);
CREATE INDEX IF NOT EXISTS idx_opp_user_score ON public.repricer_opportunity_scores(user_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_opp_user_bucket ON public.repricer_opportunity_scores(user_id, priority_bucket);

ALTER TABLE public.repricer_opportunity_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own opp scores"
  ON public.repricer_opportunity_scores FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages opp scores"
  ON public.repricer_opportunity_scores FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Adaptation log
CREATE TABLE IF NOT EXISTS public.repricer_adaptations_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text,
  marketplace text,
  adaptation_type text NOT NULL, -- state_transition | cooldown_widen | aggression_reduce | floor_decay | recovery_initiate
  before_state jsonb DEFAULT '{}'::jsonb,
  after_state jsonb DEFAULT '{}'::jsonb,
  business_reason text NOT NULL,
  technical_reason text,
  confidence numeric DEFAULT 0.7,
  auto_applied boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adapt_user_time ON public.repricer_adaptations_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adapt_asin ON public.repricer_adaptations_log(user_id, asin, created_at DESC);

ALTER TABLE public.repricer_adaptations_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own adaptations"
  ON public.repricer_adaptations_log FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages adaptations"
  ON public.repricer_adaptations_log FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Per-ASIN strategy memory (daily build)
CREATE TABLE IF NOT EXISTS public.repricer_asin_strategy_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL,
  win_rate_after_reduction numeric, -- 0..1
  bb_retention_after_increase numeric, -- 0..1
  avg_recovery_time_hours numeric,
  oscillation_tendency numeric, -- 0..1
  profit_stability_score numeric, -- 0..1
  elasticity_class text DEFAULT 'unknown', -- low | medium | high | unknown
  sample_size integer DEFAULT 0,
  last_built_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, asin, marketplace)
);
CREATE INDEX IF NOT EXISTS idx_mem_user_asin ON public.repricer_asin_strategy_memory(user_id, asin);

ALTER TABLE public.repricer_asin_strategy_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own asin memory"
  ON public.repricer_asin_strategy_memory FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages asin memory"
  ON public.repricer_asin_strategy_memory FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 4. Operator queue actions (audit of approve / ignore / escalate / auto-fix)
CREATE TABLE IF NOT EXISTS public.repricer_operator_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  operator_id uuid,
  asin text NOT NULL,
  marketplace text NOT NULL,
  action text NOT NULL, -- approved | ignored | escalated | auto_fixed
  suggested_action text,
  notes text,
  ignore_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_op_act_user_time ON public.repricer_operator_actions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_act_ignore ON public.repricer_operator_actions(user_id, ignore_until) WHERE ignore_until IS NOT NULL;

ALTER TABLE public.repricer_operator_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own operator actions"
  ON public.repricer_operator_actions FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users insert own operator actions"
  ON public.repricer_operator_actions FOR INSERT
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages operator actions"
  ON public.repricer_operator_actions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');