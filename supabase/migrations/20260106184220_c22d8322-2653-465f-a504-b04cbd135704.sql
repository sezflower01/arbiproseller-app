-- Add price_source column to track origin of sold_price
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS price_source TEXT;

-- Add comment explaining allowed values
COMMENT ON COLUMN public.sales_orders.price_source IS 'Tracks price origin: order_total_pending, orders_itemprice, financial_events';