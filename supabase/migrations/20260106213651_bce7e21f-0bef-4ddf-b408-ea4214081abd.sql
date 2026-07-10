-- Create a table to cache Buy Box prices
CREATE TABLE public.buy_box_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  asin TEXT NOT NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  price NUMERIC NOT NULL,
  fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(asin, marketplace_id)
);

-- Enable RLS
ALTER TABLE public.buy_box_cache ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read/write (shared cache)
CREATE POLICY "Authenticated users can read buy box cache"
ON public.buy_box_cache FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert buy box cache"
ON public.buy_box_cache FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update buy box cache"
ON public.buy_box_cache FOR UPDATE
TO authenticated
USING (true);

-- Index for fast lookups
CREATE INDEX idx_buy_box_cache_asin ON public.buy_box_cache(asin, marketplace_id);