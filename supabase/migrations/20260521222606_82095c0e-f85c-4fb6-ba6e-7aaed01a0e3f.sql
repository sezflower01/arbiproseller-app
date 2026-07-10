ALTER TABLE public.analyzer_decision_log
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS size_tier TEXT,
  ADD COLUMN IF NOT EXISTS amazon_presence TEXT,
  ADD COLUMN IF NOT EXISTS source_surface TEXT,
  ADD COLUMN IF NOT EXISTS active_range_viewed TEXT,
  ADD COLUMN IF NOT EXISTS scan_duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS retrieval_state TEXT,
  ADD COLUMN IF NOT EXISTS data_freshness TEXT;

CREATE INDEX IF NOT EXISTS idx_adl_user_category ON public.analyzer_decision_log(user_id, category);
CREATE INDEX IF NOT EXISTS idx_adl_user_brand ON public.analyzer_decision_log(user_id, brand);