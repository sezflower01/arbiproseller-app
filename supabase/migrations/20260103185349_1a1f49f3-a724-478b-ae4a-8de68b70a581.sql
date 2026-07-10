-- Add enrichment tracking columns to sales_orders
ALTER TABLE public.sales_orders
ADD COLUMN IF NOT EXISTS price_enrich_status text DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS price_attempt_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS price_last_attempt_at timestamptz,
ADD COLUMN IF NOT EXISTS price_last_error text;

-- Create an index for efficient querying of orders needing enrichment
CREATE INDEX IF NOT EXISTS idx_sales_orders_price_enrichment
ON public.sales_orders (user_id, price_enrich_status, sold_price, price_attempt_count)
WHERE sold_price = 0 AND price_enrich_status != 'enriched';

-- Update existing orders with sold_price = 0 to have 'pending' enrichment status
UPDATE public.sales_orders
SET price_enrich_status = 'pending'
WHERE sold_price = 0 AND price_enrich_status IS NULL;