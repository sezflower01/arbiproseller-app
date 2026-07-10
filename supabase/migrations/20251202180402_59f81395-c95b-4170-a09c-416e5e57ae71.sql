-- Add refund_quantity column to track number of refunded items
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS refund_quantity integer DEFAULT 0;