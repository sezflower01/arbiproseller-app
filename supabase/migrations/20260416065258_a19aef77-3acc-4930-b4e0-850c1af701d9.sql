
-- Add settlement_date column to sales_orders (nullable, no breaking change)
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS settlement_date date;

-- Reset the stuck historical sync for the affected user so it can be re-triggered
UPDATE public.sales_sync_state
SET historical_sync_in_progress = false,
    historical_sync_progress = NULL,
    updated_at = now()
WHERE historical_sync_in_progress = true;
