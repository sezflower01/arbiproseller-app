
-- Add smart min-price suggestion fields to repricer_ai_decisions
ALTER TABLE public.repricer_ai_decisions
  ADD COLUMN IF NOT EXISTS min_price_clamped boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS competitive_price numeric,
  ADD COLUMN IF NOT EXISTS suggested_min_price numeric,
  ADD COLUMN IF NOT EXISTS min_gap_amount numeric,
  ADD COLUMN IF NOT EXISTS min_gap_percent numeric;

-- Also add to repricer_price_actions so suggestions appear in the action log
ALTER TABLE public.repricer_price_actions
  ADD COLUMN IF NOT EXISTS min_price_suggestion jsonb;
