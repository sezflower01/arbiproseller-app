-- Add columns for tracking PENDING ASIN backfill retries
-- These track attempts to fetch order items for stuck PENDING rows

ALTER TABLE public.sales_orders
ADD COLUMN IF NOT EXISTS pending_enrich_attempts integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS pending_enrich_last_error text,
ADD COLUMN IF NOT EXISTS pending_enrich_last_attempt_at timestamptz;

-- Add index for finding stuck PENDING orders efficiently
CREATE INDEX IF NOT EXISTS idx_sales_orders_pending_asin 
ON public.sales_orders (user_id, asin, created_at) 
WHERE asin = 'PENDING' OR title = 'Order Processing...';

COMMENT ON COLUMN public.sales_orders.pending_enrich_attempts IS 'Number of attempts to fetch order items for stuck PENDING rows';
COMMENT ON COLUMN public.sales_orders.pending_enrich_last_error IS 'Last error message from pending enrichment attempt';
COMMENT ON COLUMN public.sales_orders.pending_enrich_last_attempt_at IS 'Timestamp of last pending enrichment attempt';