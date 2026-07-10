
-- Add per-SKU daily check counter for fairness rotation
ALTER TABLE public.repricer_assignments 
  ADD COLUMN IF NOT EXISTS checks_today_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checks_today_date text;
