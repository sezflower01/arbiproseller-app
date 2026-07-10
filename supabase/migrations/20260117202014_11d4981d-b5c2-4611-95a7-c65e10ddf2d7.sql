-- Add price locking and fee tracking fields to sales_orders
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS locked_est_price numeric,
ADD COLUMN IF NOT EXISTS price_locked_at timestamptz,
ADD COLUMN IF NOT EXISTS locked_from text,
ADD COLUMN IF NOT EXISTS fees_source text;

-- Add comments for clarity
COMMENT ON COLUMN public.sales_orders.locked_est_price IS 'First-seen estimate price, never overwritten by Listings API';
COMMENT ON COLUMN public.sales_orders.price_locked_at IS 'Timestamp when estimate was locked';
COMMENT ON COLUMN public.sales_orders.locked_from IS 'Source of locked price: orders_api, order_total_div_qty, inventory_fallback';
COMMENT ON COLUMN public.sales_orders.fees_source IS 'Source of fees: fees_api, estimated, unavailable, financial_events';