-- Create scraping cache table
CREATE TABLE IF NOT EXISTS public.scrape_cache (
  query text PRIMARY KEY,
  results jsonb NOT NULL,
  cached_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scrape_cache_cached_at ON public.scrape_cache(cached_at);

-- Create scraping logs table
CREATE TABLE IF NOT EXISTS public.scrape_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asin text,
  query text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('http', 'cache_hit')),
  status text NOT NULL,
  result_count int DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_scrape_logs_asin ON public.scrape_logs(asin);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_started_at ON public.scrape_logs(started_at DESC);

-- Create scraping state table for rate limiting
CREATE TABLE IF NOT EXISTS public.scrape_state (
  key text PRIMARY KEY,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on new tables
ALTER TABLE public.scrape_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_state ENABLE ROW LEVEL SECURITY;

-- Policies for scrape_cache
CREATE POLICY "Admins can manage cache" ON public.scrape_cache
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Policies for scrape_logs
CREATE POLICY "Admins can view logs" ON public.scrape_logs
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role can manage logs" ON public.scrape_logs
  FOR ALL USING (auth.role() = 'service_role');

-- Policies for scrape_state
CREATE POLICY "Admins can view state" ON public.scrape_state
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role can manage state" ON public.scrape_state
  FOR ALL USING (auth.role() = 'service_role');