-- Per-day counters for the two search providers, which had none.
--
-- WHY NOT DERIVE IT. find_source_usage and auto_source_daily_usage count
-- SEARCHES, and a search is not a CSE query: find-source-candidates issues one
-- query for the UPC and one for the title, and Pass B adds another pair when
-- the allowlist finds nothing. So one search is 1-4 CSE queries depending on
-- the listing and the pass. Presenting a search count as a CSE count on a
-- dashboard about approaching quota would be wrong by up to 4x in the
-- direction that matters -- under-reporting.
--
-- Google CSE is the one with a hard free tier: 100 queries/day, then USD 5 per
-- 1000 (confirmed in the Cloud console, see auto-source-new-listings header).
-- SerpAPI is plan-dependent and only fires when CSE returns zero results, so
-- its count doubles as a signal that CSE is failing or exhausted.
CREATE TABLE IF NOT EXISTS public.search_api_daily_usage (
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  provider text NOT NULL CHECK (provider IN ('google_cse', 'serpapi')),
  call_count bigint NOT NULL DEFAULT 0,
  -- Zero-result calls: spent quota that produced nothing. For CSE this is what
  -- triggers the SerpAPI fallback, so the two counts should roughly track.
  empty_count bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  last_error_at timestamptz,
  last_error_status integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_date, provider)
);

ALTER TABLE public.search_api_daily_usage ENABLE ROW LEVEL SECURITY;

-- Account-wide, like keepa_daily_usage and gemini_daily_usage: these are single
-- deployment-level API keys, so there is nothing to scope per user.
DROP POLICY IF EXISTS "search_api_daily_usage read" ON public.search_api_daily_usage;
CREATE POLICY "search_api_daily_usage read" ON public.search_api_daily_usage
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "search_api_daily_usage service" ON public.search_api_daily_usage;
CREATE POLICY "search_api_daily_usage service" ON public.search_api_daily_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Atomic upsert, same shape as record_gemini_call. Two searches running
-- concurrently must not lose an increment -- which a read-then-write would.
CREATE OR REPLACE FUNCTION public.record_search_api_call(
  p_provider text,
  p_ok boolean,
  p_empty boolean DEFAULT false,
  p_status integer DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.search_api_daily_usage AS s (
    usage_date, provider, call_count, empty_count, error_count,
    last_error_at, last_error_status, updated_at
  )
  VALUES (
    CURRENT_DATE, p_provider, 1,
    CASE WHEN p_ok AND p_empty THEN 1 ELSE 0 END,
    CASE WHEN p_ok THEN 0 ELSE 1 END,
    CASE WHEN p_ok THEN NULL ELSE now() END,
    CASE WHEN p_ok THEN NULL ELSE p_status END,
    now()
  )
  ON CONFLICT (usage_date, provider) DO UPDATE SET
    call_count        = s.call_count + 1,
    empty_count       = s.empty_count + CASE WHEN p_ok AND p_empty THEN 1 ELSE 0 END,
    error_count       = s.error_count + CASE WHEN p_ok THEN 0 ELSE 1 END,
    last_error_at     = CASE WHEN p_ok THEN s.last_error_at ELSE now() END,
    last_error_status = CASE WHEN p_ok THEN s.last_error_status ELSE p_status END,
    updated_at        = now();
$$;

REVOKE ALL ON FUNCTION public.record_search_api_call(text, boolean, boolean, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.record_search_api_call(text, boolean, boolean, integer) TO service_role;
