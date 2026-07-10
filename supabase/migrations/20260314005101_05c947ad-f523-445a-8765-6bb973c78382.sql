
ALTER TABLE public.rainforest_daily_usage 
  ADD COLUMN IF NOT EXISTS sp_api_throttled_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_fallback_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rainforest_success_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rainforest_skipped_not_priority integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rainforest_skipped_cache_fresh integer NOT NULL DEFAULT 0;
