ALTER TABLE public.repricer_assignments 
  ADD COLUMN IF NOT EXISTS manual_override_started_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS manual_override_checks integer DEFAULT 0;