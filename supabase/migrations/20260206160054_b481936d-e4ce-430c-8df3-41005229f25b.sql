-- Add fee_source, last_verified_at, history_sample_size to asin_fee_cache for debugging/observability
ALTER TABLE public.asin_fee_cache 
  ADD COLUMN IF NOT EXISTS fee_source text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS history_sample_size integer DEFAULT 0;