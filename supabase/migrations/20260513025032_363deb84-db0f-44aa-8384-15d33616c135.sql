-- 1. Buy Box Quality
CREATE TABLE IF NOT EXISTS public.repricer_buybox_quality (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL,
  quality_score numeric NOT NULL DEFAULT 0,
  margin_quality numeric,           -- 0..1, profitable vs floor
  price_stability numeric,          -- 0..1
  hold_duration_hours numeric,
  velocity_after_win numeric,       -- units/day post-win
  competitor_quality numeric,       -- 0..1, are competitors strong
  recovery_sustainability numeric,  -- 0..1
  classification text DEFAULT 'unknown', -- profitable_winner | unprofitable_winner | volatile_winner | losing
  signals jsonb DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, marketplace)
);
CREATE INDEX IF NOT EXISTS idx_bbq_user_score ON public.repricer_buybox_quality(user_id, quality_score DESC);
ALTER TABLE public.repricer_buybox_quality ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own bb quality"
  ON public.repricer_buybox_quality FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages bb quality"
  ON public.repricer_buybox_quality FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Competitor profiles
CREATE TABLE IF NOT EXISTS public.repricer_competitor_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL,
  competitor_seller_id text NOT NULL,
  classification text NOT NULL DEFAULT 'unknown',
  avg_reaction_minutes numeric,
  undercut_pattern_cents numeric,
  volatility numeric,
  observation_count integer DEFAULT 0,
  last_seen timestamptz,
  signals jsonb DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, marketplace, competitor_seller_id)
);
CREATE INDEX IF NOT EXISTS idx_compprof_asin ON public.repricer_competitor_profiles(user_id, asin, marketplace);
ALTER TABLE public.repricer_competitor_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own competitor profiles"
  ON public.repricer_competitor_profiles FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages competitor profiles"
  ON public.repricer_competitor_profiles FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Marketplace intelligence
CREATE TABLE IF NOT EXISTS public.repricer_marketplace_intelligence (
  user_id uuid NOT NULL,
  marketplace text NOT NULL,
  volatility_score numeric DEFAULT 0,        -- 0..1
  avg_competitor_aggression numeric DEFAULT 0,
  bb_stability_score numeric DEFAULT 0,
  floor_sensitivity numeric DEFAULT 0,
  recommended_aggression text DEFAULT 'balanced',
  decision_churn_score numeric DEFAULT 0,    -- P6 stability metric
  signals jsonb DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, marketplace)
);
ALTER TABLE public.repricer_marketplace_intelligence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own marketplace intel"
  ON public.repricer_marketplace_intelligence FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Service role manages marketplace intel"
  ON public.repricer_marketplace_intelligence FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 4. Strategic insights (weekly AI advisor)
CREATE TABLE IF NOT EXISTS public.repricer_strategic_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL DEFAULT 'general', -- margin | inventory | competition | recovery | marketplace | general
  severity text NOT NULL DEFAULT 'info',    -- info | watch | important
  headline text NOT NULL,
  body text NOT NULL,
  expected_impact_usd numeric,
  affected_asins integer DEFAULT 0,
  marketplace text,
  source_data jsonb DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_insights_user_time ON public.repricer_strategic_insights(user_id, generated_at DESC);
ALTER TABLE public.repricer_strategic_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own insights"
  ON public.repricer_strategic_insights FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users acknowledge own insights"
  ON public.repricer_strategic_insights FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manages insights"
  ON public.repricer_strategic_insights FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');