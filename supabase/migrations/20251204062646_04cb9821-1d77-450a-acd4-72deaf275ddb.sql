-- Add backfill tracking to sales_sync_state
ALTER TABLE public.sales_sync_state
ADD COLUMN IF NOT EXISTS backfill_cursor_date DATE,
ADD COLUMN IF NOT EXISTS backfill_complete BOOLEAN DEFAULT false;

-- Initialize backfill_cursor_date to today for existing users (will work backwards)
UPDATE public.sales_sync_state
SET backfill_cursor_date = CURRENT_DATE,
    backfill_complete = false
WHERE backfill_cursor_date IS NULL;