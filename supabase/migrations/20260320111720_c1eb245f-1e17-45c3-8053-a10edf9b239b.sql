ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS schedule_timezone text NOT NULL DEFAULT 'America/Chicago';