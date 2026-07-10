ALTER TABLE public.sales_sync_state
  ADD COLUMN IF NOT EXISTS last_backfill_stats jsonb;