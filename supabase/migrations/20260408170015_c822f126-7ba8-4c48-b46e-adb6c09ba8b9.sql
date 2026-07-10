-- Add a real UTC timestamp column to sales_orders for true rolling-hour windows
ALTER TABLE public.sales_orders
ADD COLUMN IF NOT EXISTS purchase_timestamp_utc TIMESTAMPTZ;

-- Create index for efficient rolling-window queries (popup filters by user + timestamp range)
CREATE INDEX IF NOT EXISTS idx_sales_orders_purchase_ts
ON public.sales_orders (user_id, purchase_timestamp_utc DESC)
WHERE purchase_timestamp_utc IS NOT NULL;

-- Backfill existing rows: use created_at as best approximation for historical data
-- (created_at is when the row was inserted, which is close to purchase time for live-synced orders)
UPDATE public.sales_orders
SET purchase_timestamp_utc = created_at
WHERE purchase_timestamp_utc IS NULL
  AND created_at IS NOT NULL;