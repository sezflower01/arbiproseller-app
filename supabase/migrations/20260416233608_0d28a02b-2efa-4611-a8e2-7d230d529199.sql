-- Add notes + preferred flag to saved_sources, and previous_run_id pointer to runs
ALTER TABLE public.saved_sources
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS is_preferred BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.source_discovery_runs
  ADD COLUMN IF NOT EXISTS previous_run_id UUID REFERENCES public.source_discovery_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_saved_sources_preferred
  ON public.saved_sources(user_id, asin, is_preferred);

CREATE INDEX IF NOT EXISTS idx_source_discovery_runs_previous
  ON public.source_discovery_runs(previous_run_id);