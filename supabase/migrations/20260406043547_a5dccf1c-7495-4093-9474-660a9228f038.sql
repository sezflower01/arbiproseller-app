ALTER TABLE public.repricer_assignments 
  ADD COLUMN IF NOT EXISTS consecutive_failed_undercuts integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_price_direction text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS direction_changed_at timestamptz DEFAULT NULL;