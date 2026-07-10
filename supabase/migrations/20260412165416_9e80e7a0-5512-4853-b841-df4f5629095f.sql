
-- Add bounds sync state columns to repricer_assignments
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS bounds_sync_status text NOT NULL DEFAULT 'synced',
  ADD COLUMN IF NOT EXISTS bounds_sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_bounds_sync_error text,
  ADD COLUMN IF NOT EXISTS next_bounds_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS bounds_last_requested_at timestamptz;

-- Index for the background worker to efficiently find pending rows
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_bounds_pending
  ON public.repricer_assignments (bounds_sync_status, next_bounds_sync_at)
  WHERE bounds_sync_status IN ('pending', 'failed');

-- Backfill: any row that currently has bounds_synced_at IS NULL and min_price_override IS NOT NULL
-- should be marked as pending so the new worker picks them up
UPDATE public.repricer_assignments
SET bounds_sync_status = 'pending',
    bounds_last_requested_at = now()
WHERE min_price_override IS NOT NULL
  AND bounds_synced_at IS NULL
  AND bounds_sync_status = 'synced';
