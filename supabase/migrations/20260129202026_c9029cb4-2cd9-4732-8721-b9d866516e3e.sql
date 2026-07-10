-- Add rate limit backoff tracking column
ALTER TABLE public.repricer_settings 
ADD COLUMN IF NOT EXISTS rate_limit_backoff_seconds integer DEFAULT 30;