
-- 1. Per-review tier + escalation reasons
ALTER TABLE public.smart_engine_ai_reviews
  ADD COLUMN IF NOT EXISTS model_tier text,
  ADD COLUMN IF NOT EXISTS escalation_reasons text[] DEFAULT ARRAY[]::text[];

COMMENT ON COLUMN public.smart_engine_ai_reviews.model_tier IS
  'Which routing tier handled this review: flash (cheap/bulk), pro (deep), or skip (rule-based, no LLM).';
COMMENT ON COLUMN public.smart_engine_ai_reviews.escalation_reasons IS
  'List of trigger keys that caused Pro escalation, e.g. {repeated_bb_loss,oscillation,high_value,treatment_divergence,multi_undercut}.';

-- 2. Per-batch tier rollup (for cost dashboards)
ALTER TABLE public.smart_engine_ai_review_batches
  ADD COLUMN IF NOT EXISTS pro_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flash_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skip_count integer NOT NULL DEFAULT 0;

-- 3. Pro budget ledger (daily cap enforcement)
CREATE TABLE IF NOT EXISTS public.smart_engine_pro_budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  budget_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  pro_reviews_used integer NOT NULL DEFAULT 0,
  pro_reviews_cap integer NOT NULL DEFAULT 100,
  last_review_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, budget_date)
);

CREATE INDEX IF NOT EXISTS idx_pro_budget_user_date
  ON public.smart_engine_pro_budget (user_id, budget_date DESC);

ALTER TABLE public.smart_engine_pro_budget ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own pro budget"
  ON public.smart_engine_pro_budget
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- Writes happen via service role from the edge function; no INSERT/UPDATE policy
-- for end users (intentional: prevents client-side cap manipulation).

COMMENT ON TABLE public.smart_engine_pro_budget IS
  'Phase 2: daily ceiling on Pro (deep LLM) reviews per user. Default cap = 100/day. Reset by date partition (UTC).';
