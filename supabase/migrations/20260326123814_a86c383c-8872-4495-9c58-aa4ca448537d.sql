ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS auto_floor_drop_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_floor_consecutive_losses integer NOT NULL DEFAULT 0;