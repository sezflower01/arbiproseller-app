-- Additional columns needed to resume sync-fnsku-report across multiple
-- bounded invocations: which report (FBA then later FBM, sequential, never
-- concurrent, so one pair of columns suffices) is currently being polled,
-- how many poll attempts so far this phase, and a generic cursor/total pair
-- reused across the backfill and outer-enrichment phases.
ALTER TABLE public.fnsku_sync_history
  ADD COLUMN IF NOT EXISTS poll_attempts integer,
  ADD COLUMN IF NOT EXISTS cursor_offset integer,
  ADD COLUMN IF NOT EXISTS cursor_total integer;
