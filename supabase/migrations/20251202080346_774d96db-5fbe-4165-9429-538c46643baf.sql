-- Add marketplace field to sales_orders to track which country the sale came from
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS marketplace TEXT DEFAULT 'US';

-- Add index for filtering by marketplace
CREATE INDEX IF NOT EXISTS idx_sales_orders_marketplace ON public.sales_orders(marketplace);