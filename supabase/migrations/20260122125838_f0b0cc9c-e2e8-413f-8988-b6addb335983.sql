-- Add seller_sku column to sales_orders for SKU-level pricing
-- This enables correct price matching when multiple offers exist for same ASIN

-- Add seller_sku column (nullable, since existing records won't have it)
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS seller_sku text;

-- Create index for SKU-based lookups (user_id, seller_sku)
CREATE INDEX IF NOT EXISTS idx_sales_orders_user_sku 
ON public.sales_orders (user_id, seller_sku) 
WHERE seller_sku IS NOT NULL;

-- Create composite index for efficient SKU+ASIN lookups
CREATE INDEX IF NOT EXISTS idx_sales_orders_user_asin_sku 
ON public.sales_orders (user_id, asin, seller_sku);

-- Add comment explaining the column purpose
COMMENT ON COLUMN public.sales_orders.seller_sku IS 
'The exact seller SKU that was sold, used for accurate pricing when multiple offers exist for same ASIN (e.g., New vs Used conditions)';