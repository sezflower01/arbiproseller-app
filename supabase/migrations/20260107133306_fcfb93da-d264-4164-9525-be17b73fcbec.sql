-- Add asin_source column to track whether ASIN is real or needs resolution
-- Values: 'exact' (real ASIN from API), 'resolved' (resolved from SKU via Orders API), 'unknown' (SKU stored as ASIN, needs resolution)
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS asin_source text DEFAULT 'exact';

-- Add index for finding unmapped orders efficiently
CREATE INDEX IF NOT EXISTS idx_sales_orders_asin_source 
ON public.sales_orders(asin_source) 
WHERE asin_source = 'unknown';

-- Update existing rows: if asin doesn't match ASIN pattern (B0 + 8 alphanumeric), mark as 'unknown'
UPDATE public.sales_orders
SET asin_source = 'unknown'
WHERE asin !~ '^B0[A-Z0-9]{8}$' 
  AND asin IS NOT NULL 
  AND asin != '';