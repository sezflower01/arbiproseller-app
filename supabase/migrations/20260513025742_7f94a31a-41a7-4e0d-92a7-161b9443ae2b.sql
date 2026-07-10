ALTER TABLE public.repricer_strategic_insights
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS impact_tier text NOT NULL DEFAULT 'medium';

CREATE UNIQUE INDEX IF NOT EXISTS uq_insights_user_dedupe
  ON public.repricer_strategic_insights(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.repricer_recommendation_fatigue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text,
  action_kind text NOT NULL,
  dismiss_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  last_dismissed_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  fatigue_score numeric NOT NULL DEFAULT 0,  -- 0..1, higher = more fatigued
  UNIQUE (user_id, asin, action_kind)
);
CREATE INDEX IF NOT EXISTS idx_fatigue_user ON public.repricer_recommendation_fatigue(user_id, fatigue_score DESC);

ALTER TABLE public.repricer_recommendation_fatigue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own fatigue"
  ON public.repricer_recommendation_fatigue FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users insert own fatigue"
  ON public.repricer_recommendation_fatigue FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own fatigue"
  ON public.repricer_recommendation_fatigue FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Service manages fatigue"
  ON public.repricer_recommendation_fatigue FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');