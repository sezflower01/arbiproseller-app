-- Run-to-run comparison: auto-link previous run for same ASIN+user
ALTER TABLE public.source_discovery_runs
  ADD COLUMN IF NOT EXISTS quality_badge TEXT,
  ADD COLUMN IF NOT EXISTS top_valid_domain TEXT;

-- Backfill previous_run_id (added in prior migration) by chronology per (user_id, asin)
WITH ranked AS (
  SELECT id, user_id, asin,
    LAG(id) OVER (PARTITION BY user_id, asin ORDER BY created_at) AS prev_id
  FROM public.source_discovery_runs
)
UPDATE public.source_discovery_runs r
SET previous_run_id = ranked.prev_id
FROM ranked
WHERE r.id = ranked.id
  AND r.previous_run_id IS NULL
  AND ranked.prev_id IS NOT NULL;

-- Auto-link previous_run_id on insert (per user+asin)
CREATE OR REPLACE FUNCTION public.fn_link_previous_discovery_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.previous_run_id IS NULL THEN
    SELECT id INTO NEW.previous_run_id
    FROM public.source_discovery_runs
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND id <> NEW.id
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_previous_discovery_run ON public.source_discovery_runs;
CREATE TRIGGER trg_link_previous_discovery_run
BEFORE INSERT ON public.source_discovery_runs
FOR EACH ROW EXECUTE FUNCTION public.fn_link_previous_discovery_run();

-- Saved sources: track last recheck state
ALTER TABLE public.saved_sources
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_status TEXT,           -- 'extracted' | 'blocked' | 'unresolved' | 'invalid'
  ADD COLUMN IF NOT EXISTS last_resolution TEXT,       -- mirrors final_resolution
  ADD COLUMN IF NOT EXISTS last_confidence NUMERIC;

-- QA batch persistence: extend supplier_qa_batches with reviewable details
ALTER TABLE public.supplier_qa_batches
  ADD COLUMN IF NOT EXISTS asin_list TEXT[],
  ADD COLUMN IF NOT EXISTS run_ids UUID[],
  ADD COLUMN IF NOT EXISTS aggregate_metrics JSONB;

-- Index for fast comparison lookups
CREATE INDEX IF NOT EXISTS idx_discovery_runs_user_asin_created
  ON public.source_discovery_runs (user_id, asin, created_at DESC);
