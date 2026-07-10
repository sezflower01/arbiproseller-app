-- Allow 'pending' status on store_scan_items so we can pre-create rows during crawl phase
-- and process them in chunks. Existing constraint may not exist; we add an index for fast pending lookup.
CREATE INDEX IF NOT EXISTS idx_store_scan_items_run_pending
  ON public.store_scan_items (run_id, created_at)
  WHERE status = 'pending';

-- Add a tiny lease column on the runs table to prevent overlapping chunk workers
ALTER TABLE public.store_scan_runs
  ADD COLUMN IF NOT EXISTS chunk_lease_until TIMESTAMPTZ;