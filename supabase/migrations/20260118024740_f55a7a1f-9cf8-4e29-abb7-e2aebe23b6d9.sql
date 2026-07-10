-- Add attempt tracking fields to asin_fee_cache
ALTER TABLE public.asin_fee_cache 
ADD COLUMN IF NOT EXISTS last_attempt_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error text,
ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone;

-- Create index for efficient backfill queries
CREATE INDEX IF NOT EXISTS idx_asin_fee_cache_next_retry 
ON public.asin_fee_cache (user_id, next_retry_at) 
WHERE next_retry_at IS NOT NULL;

-- Create index for finding ASINs that need backfill
CREATE INDEX IF NOT EXISTS idx_sales_orders_fees_unavailable 
ON public.sales_orders (user_id, asin, fees_source) 
WHERE fees_source = 'unavailable' OR fees_source IS NULL;