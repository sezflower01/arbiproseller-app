ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS last_trigger_source text,
  ADD COLUMN IF NOT EXISTS last_data_source text,
  ADD COLUMN IF NOT EXISTS last_throttle_at timestamptz;