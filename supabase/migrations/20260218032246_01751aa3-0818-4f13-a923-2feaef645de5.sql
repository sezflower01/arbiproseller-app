
ALTER TABLE public.repricer_settings 
ADD COLUMN IF NOT EXISTS continuous_mode boolean NOT NULL DEFAULT false;
