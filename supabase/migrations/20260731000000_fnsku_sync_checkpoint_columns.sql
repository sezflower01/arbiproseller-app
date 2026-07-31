-- Instrumentation + checkpointing for sync-fnsku-report, added to diagnose
-- why ~17% of all historical sync attempts (759/4497 for this account) get
-- permanently stuck in 'in_progress' with no completion or failure ever
-- recorded. `phase`/`last_heartbeat_at` let us pinpoint exactly where a
-- run stalls; `timed_out` (added as an allowed status below) lets a
-- safety-net sweep distinguish a genuinely dead run from one still working.
ALTER TABLE public.fnsku_sync_history
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS report_id text,
  ADD COLUMN IF NOT EXISTS enrichment_processed integer,
  ADD COLUMN IF NOT EXISTS enrichment_total integer;

DO $$
BEGIN
  ALTER TABLE public.fnsku_sync_history DROP CONSTRAINT IF EXISTS fnsku_sync_history_status_check;
  ALTER TABLE public.fnsku_sync_history
    ADD CONSTRAINT fnsku_sync_history_status_check
    CHECK (status IN ('in_progress', 'completed', 'failed', 'timed_out'));
EXCEPTION WHEN others THEN
  -- If the table never had a named CHECK constraint (status was unconstrained),
  -- there's nothing to replace and nothing further to do.
  NULL;
END $$;
