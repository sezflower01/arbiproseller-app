
-- Keepa price history cache (per ASIN/marketplace/range)
CREATE TABLE IF NOT EXISTS public.keepa_price_history_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  days_range INTEGER NOT NULL,
  series JSONB NOT NULL,
  offers JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (asin, marketplace, days_range)
);
ALTER TABLE public.keepa_price_history_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read price history cache"
  ON public.keepa_price_history_cache FOR SELECT
  TO authenticated USING (true);

-- Keepa seller name cache (shared across users)
CREATE TABLE IF NOT EXISTS public.keepa_seller_name_cache (
  seller_id TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  business_name TEXT,
  storefront_name TEXT,
  is_amazon BOOLEAN NOT NULL DEFAULT false,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (seller_id, marketplace)
);
ALTER TABLE public.keepa_seller_name_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read seller name cache"
  ON public.keepa_seller_name_cache FOR SELECT
  TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_keepa_price_history_expires ON public.keepa_price_history_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_keepa_seller_cache_expires ON public.keepa_seller_name_cache (expires_at);
