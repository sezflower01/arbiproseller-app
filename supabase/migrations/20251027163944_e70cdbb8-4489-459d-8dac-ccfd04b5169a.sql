-- Create scrape cache table
CREATE TABLE IF NOT EXISTS public.scrape_cache (
  query TEXT PRIMARY KEY,
  results JSONB NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create scrape logs table
CREATE TABLE IF NOT EXISTS public.scrape_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asin TEXT,
  query TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  result_count INTEGER,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- Create scrape state table for tracking blocks
CREATE TABLE IF NOT EXISTS public.scrape_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add index for faster cache lookups
CREATE INDEX IF NOT EXISTS idx_scrape_cache_cached_at ON public.scrape_cache(cached_at);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_query ON public.scrape_logs(query);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_started_at ON public.scrape_logs(started_at);

-- Enable RLS
ALTER TABLE public.scrape_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_state ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read cache
CREATE POLICY "Allow authenticated users to read cache" ON public.scrape_cache
  FOR SELECT TO authenticated USING (true);

-- Allow service role to manage cache
CREATE POLICY "Allow service role to manage cache" ON public.scrape_cache
  FOR ALL TO service_role USING (true);

-- Allow authenticated users to read logs
CREATE POLICY "Allow authenticated users to read logs" ON public.scrape_logs
  FOR SELECT TO authenticated USING (true);

-- Allow service role to manage logs
CREATE POLICY "Allow service role to manage logs" ON public.scrape_logs
  FOR ALL TO service_role USING (true);

-- Allow authenticated users to read state
CREATE POLICY "Allow authenticated users to read state" ON public.scrape_state
  FOR SELECT TO authenticated USING (true);

-- Allow service role to manage state
CREATE POLICY "Allow service role to manage state" ON public.scrape_state
  FOR ALL TO service_role USING (true);