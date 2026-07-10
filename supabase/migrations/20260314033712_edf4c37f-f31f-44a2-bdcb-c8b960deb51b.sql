CREATE TABLE IF NOT EXISTS public.keepa_daily_usage (
  usage_date date PRIMARY KEY DEFAULT CURRENT_DATE,
  call_count integer NOT NULL DEFAULT 0,
  keepa_success_count integer NOT NULL DEFAULT 0,
  keepa_skipped_not_eligible integer NOT NULL DEFAULT 0,
  keepa_skipped_cache_fresh integer NOT NULL DEFAULT 0,
  keepa_skipped_token_budget integer NOT NULL DEFAULT 0,
  sp_api_throttled_count integer NOT NULL DEFAULT 0,
  cache_fallback_count integer NOT NULL DEFAULT 0,
  last_called_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.keepa_daily_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read keepa_daily_usage"
  ON public.keepa_daily_usage FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can manage keepa_daily_usage"
  ON public.keepa_daily_usage FOR ALL TO service_role USING (true) WITH CHECK (true);