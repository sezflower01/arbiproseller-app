-- Add refund_amount column to sales_orders table
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS refund_amount numeric DEFAULT 0;

-- Add comment for clarity
COMMENT ON COLUMN public.sales_orders.refund_amount IS 'Refund amount in USD for this order item';