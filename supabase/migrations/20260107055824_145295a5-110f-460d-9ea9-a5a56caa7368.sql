-- Create a cache table for period totals to avoid recalculating on every page load
CREATE TABLE public.sales_period_totals_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'all',
  date_start DATE NOT NULL,
  date_end DATE NOT NULL,
  timezone_cutoff TEXT NOT NULL DEFAULT 'amazon_day_2am',
  include_settled BOOLEAN NOT NULL DEFAULT false,
  hide_deferred BOOLEAN NOT NULL DEFAULT false,
  
  -- Totals
  sales_total NUMERIC NOT NULL DEFAULT 0,
  amazon_fees_total NUMERIC NOT NULL DEFAULT 0,
  fba_fee_total NUMERIC NOT NULL DEFAULT 0,
  referral_fee_total NUMERIC NOT NULL DEFAULT 0,
  closing_fee_total NUMERIC NOT NULL DEFAULT 0,
  cogs_total NUMERIC NOT NULL DEFAULT 0,
  refund_cost_total NUMERIC NOT NULL DEFAULT 0,
  gross_profit NUMERIC NOT NULL DEFAULT 0,
  net_profit NUMERIC NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Unique constraint for cache key
  CONSTRAINT sales_period_totals_cache_unique_key UNIQUE (
    user_id, seller_id, marketplace_id, date_start, date_end, 
    timezone_cutoff, include_settled, hide_deferred
  )
);

-- Enable RLS
ALTER TABLE public.sales_period_totals_cache ENABLE ROW LEVEL SECURITY;

-- Users can only access their own cache
CREATE POLICY "Users can manage their own period cache"
ON public.sales_period_totals_cache
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Index for fast lookups
CREATE INDEX idx_sales_period_cache_lookup 
ON public.sales_period_totals_cache (user_id, seller_id, date_start, date_end);

-- Trigger to update updated_at
CREATE TRIGGER update_sales_period_totals_cache_updated_at
BEFORE UPDATE ON public.sales_period_totals_cache
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();