-- Add estimated_price column for Buy Box UI display (never used in calculations)
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS estimated_price NUMERIC DEFAULT NULL;

-- Add comment explaining the field
COMMENT ON COLUMN public.sales_orders.estimated_price IS 'Buy Box price for UI display only. Never used as source of truth for sold_price.';