-- Add fees_missing column to sales_orders for tracking unavailable fees
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS fees_missing boolean DEFAULT false;

-- Create index for efficient querying of orders with missing fees
CREATE INDEX IF NOT EXISTS idx_sales_orders_fees_missing 
ON public.sales_orders(user_id, fees_missing) 
WHERE fees_missing = true;