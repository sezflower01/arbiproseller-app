-- Live Sales period snapshot cache
-- Mirrors the inventory_valuation_summary pattern: cron writes closed-period
-- aggregates here; reader merges today's live delta on top so switching
-- Month/YTD/Last Month becomes near-instant without losing freshness.

CREATE TABLE IF NOT EXISTS public.live_sales_period_cache (
  user_id              uuid        NOT NULL,
  marketplace          text        NOT NULL,            -- 'US' | 'CA' | 'MX' | 'BR' | 'ALL'
  period_key           text        NOT NULL,            -- e.g. 'month-2026-05', 'last-month', 'ytd-closed-2026', 'year-2025'
  period_start         date        NOT NULL,            -- inclusive, in user's sales business TZ
  period_end           date        NOT NULL,            -- inclusive (yesterday for YTD; last day for closed months)
  totals               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  asin_rows            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sales_sync_version   bigint      NOT NULL DEFAULT 0,
  source_row_count     integer     NOT NULL DEFAULT 0,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  computed_duration_ms integer,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, marketplace, period_key)
);

CREATE INDEX IF NOT EXISTS live_sales_period_cache_user_computed_idx
  ON public.live_sales_period_cache (user_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS live_sales_period_cache_user_period_idx
  ON public.live_sales_period_cache (user_id, period_key);

-- Standard updated_at trigger (reuse shared helper if present, else create local)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_live_sales_period_cache_updated_at ON public.live_sales_period_cache;
CREATE TRIGGER update_live_sales_period_cache_updated_at
  BEFORE UPDATE ON public.live_sales_period_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Grants: snapshot is per-user; no anon access (all policies scope to auth.uid)
GRANT SELECT ON public.live_sales_period_cache TO authenticated;
GRANT ALL    ON public.live_sales_period_cache TO service_role;

ALTER TABLE public.live_sales_period_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own live sales period cache"
  ON public.live_sales_period_cache;
CREATE POLICY "Users read own live sales period cache"
  ON public.live_sales_period_cache
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages live sales period cache"
  ON public.live_sales_period_cache;
CREATE POLICY "Service role manages live sales period cache"
  ON public.live_sales_period_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
