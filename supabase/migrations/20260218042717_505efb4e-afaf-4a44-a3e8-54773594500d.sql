
-- Add rotation pool columns to repricer_settings
-- rotation_pool stores ALL ASINs that should cycle through priority queue
-- rotation_cursor tracks current position in the pool
ALTER TABLE public.repricer_settings 
  ADD COLUMN IF NOT EXISTS auto_turbo_rotation_pool jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_turbo_rotation_cursor integer DEFAULT 0;

COMMENT ON COLUMN public.repricer_settings.auto_turbo_rotation_pool IS 'Persistent list of ASINs to rotate through priority queue in groups of 5';
COMMENT ON COLUMN public.repricer_settings.auto_turbo_rotation_cursor IS 'Current index position in the rotation pool';
