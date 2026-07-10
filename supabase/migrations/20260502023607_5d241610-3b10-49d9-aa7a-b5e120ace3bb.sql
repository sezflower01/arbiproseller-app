CREATE TABLE IF NOT EXISTS public.keepa_price_stability_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  current_price NUMERIC,
  min_price NUMERIC,
  avg_price NUMERIC,
  max_price NUMERIC,
  swing_pct NUMERIC,
  drops_90 INTEGER,
  days_covered INTEGER,
  verdict TEXT NOT NULL DEFAULT 'unknown',
  series_used TEXT,
  raw JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (asin, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_keepa_price_stability_expires ON public.keepa_price_stability_cache (expires_at);

ALTER TABLE public.keepa_price_stability_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read price stability"
  ON public.keepa_price_stability_cache
  FOR SELECT
  TO authenticated
  USING (true);

-- Only service role writes (default deny for INSERT/UPDATE/DELETE for normal users)