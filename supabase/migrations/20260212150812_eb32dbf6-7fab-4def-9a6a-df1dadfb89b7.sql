
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS scheduler_batch_size integer NOT NULL DEFAULT 100;
