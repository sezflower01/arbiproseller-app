
-- Add marketplace attribution columns to financial_events_cache
ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS marketplace text DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS marketplace_id text DEFAULT NULL;

-- Create index for marketplace-filtered queries
CREATE INDEX IF NOT EXISTS idx_financial_events_cache_marketplace 
  ON public.financial_events_cache (user_id, marketplace, event_date);
