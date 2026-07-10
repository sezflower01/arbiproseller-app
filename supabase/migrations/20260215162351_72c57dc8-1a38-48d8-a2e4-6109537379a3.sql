
-- Shared rate limiter + priority auto-pause columns on repricer_settings
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS sp_api_calls_this_window integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS sp_api_window_start timestamp with time zone DEFAULT now(),
ADD COLUMN IF NOT EXISTS sp_api_calls_per_minute_cap integer NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS priority_paused boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS priority_auto_resume_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS priority_pause_reason text,
ADD COLUMN IF NOT EXISTS priority_backoff_seconds integer NOT NULL DEFAULT 60;
