
CREATE TABLE IF NOT EXISTS public.rainforest_daily_usage (
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  call_count integer NOT NULL DEFAULT 0,
  last_called_at timestamptz DEFAULT now(),
  PRIMARY KEY (usage_date)
);

-- Allow service role full access (edge functions use service role)
ALTER TABLE public.rainforest_daily_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON public.rainforest_daily_usage
  FOR ALL USING (true) WITH CHECK (true);
