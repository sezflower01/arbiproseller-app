ALTER TABLE public.store_scan_runs
  ADD COLUMN IF NOT EXISTS chunk_lease_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_store_scan_runs_chunk_lease
  ON public.store_scan_runs (chunk_lease_until)
  WHERE chunk_lease_until IS NOT NULL;