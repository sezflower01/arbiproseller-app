-- 1. Keepa historical price cache (shared across users, 15-min buckets)
CREATE TABLE IF NOT EXISTS public.keepa_price_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  bucket_ts TIMESTAMPTZ NOT NULL, -- truncated to 15-min boundary
  price_usd NUMERIC,              -- nullable if Keepa returned no data
  source TEXT,                    -- 'buybox' | 'new_fba' | 'new' | 'amazon' | 'none'
  raw_price_cents INTEGER,
  domain_id INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  CONSTRAINT keepa_price_cache_uniq UNIQUE (asin, marketplace, bucket_ts)
);

CREATE INDEX IF NOT EXISTS idx_keepa_price_cache_lookup
  ON public.keepa_price_cache (asin, marketplace, bucket_ts);
CREATE INDEX IF NOT EXISTS idx_keepa_price_cache_expires
  ON public.keepa_price_cache (expires_at);

ALTER TABLE public.keepa_price_cache ENABLE ROW LEVEL SECURITY;

-- Service role only (no client access)
CREATE POLICY "Service role manages keepa_price_cache"
  ON public.keepa_price_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2. Keepa estimate vs actual accuracy log
CREATE TABLE IF NOT EXISTS public.keepa_estimate_accuracy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  order_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT,
  order_date TIMESTAMPTZ,
  keepa_estimate NUMERIC NOT NULL,
  actual_price NUMERIC NOT NULL,
  delta_abs NUMERIC GENERATED ALWAYS AS (ABS(actual_price - keepa_estimate)) STORED,
  delta_pct NUMERIC GENERATED ALWAYS AS (
    CASE WHEN actual_price > 0 THEN ABS(actual_price - keepa_estimate) / actual_price ELSE NULL END
  ) STORED,
  flagged BOOLEAN NOT NULL DEFAULT false, -- true when delta_pct > 0.05
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_keepa_accuracy_user_date
  ON public.keepa_estimate_accuracy (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keepa_accuracy_flagged
  ON public.keepa_estimate_accuracy (flagged) WHERE flagged = true;

ALTER TABLE public.keepa_estimate_accuracy ENABLE ROW LEVEL SECURITY;

-- Service role writes
CREATE POLICY "Service role manages keepa_estimate_accuracy"
  ON public.keepa_estimate_accuracy
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Admins can view their own log entries
CREATE POLICY "Admins view keepa_estimate_accuracy"
  ON public.keepa_estimate_accuracy
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));