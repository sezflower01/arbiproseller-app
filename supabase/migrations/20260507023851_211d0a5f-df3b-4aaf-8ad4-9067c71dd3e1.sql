ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS market_volatility_score numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS market_state text DEFAULT 'calm',
  ADD COLUMN IF NOT EXISTS competitor_churn_rate numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bb_rotation_rate numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS market_volatility_signals jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_position_gap_cents integer,
  ADD COLUMN IF NOT EXISTS market_volatility_checked_at timestamptz;