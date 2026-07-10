-- Create asin_my_price_cache table for storing user's actual listing prices
CREATE TABLE public.asin_my_price_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  my_price NUMERIC,
  currency TEXT DEFAULT 'USD',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT DEFAULT 'listings_api',
  attempt_count INTEGER DEFAULT 0,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, asin, marketplace_id)
);

-- Enable RLS
ALTER TABLE public.asin_my_price_cache ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view their own price cache"
  ON public.asin_my_price_cache FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own price cache"
  ON public.asin_my_price_cache FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own price cache"
  ON public.asin_my_price_cache FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own price cache"
  ON public.asin_my_price_cache FOR DELETE
  USING (auth.uid() = user_id);

-- Index for fast lookups
CREATE INDEX idx_my_price_cache_lookup ON public.asin_my_price_cache(user_id, asin, marketplace_id);
CREATE INDEX idx_my_price_cache_retry ON public.asin_my_price_cache(next_retry_at) WHERE next_retry_at IS NOT NULL;

-- Trigger for updated_at
CREATE TRIGGER update_my_price_cache_updated_at
  BEFORE UPDATE ON public.asin_my_price_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();