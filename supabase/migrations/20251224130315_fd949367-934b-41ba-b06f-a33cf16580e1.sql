-- Add order_type column to track replacement orders vs standard orders
ALTER TABLE public.sales_orders 
ADD COLUMN order_type text DEFAULT 'StandardOrder';

-- Add comment for clarity
COMMENT ON COLUMN public.sales_orders.order_type IS 'Amazon order type: StandardOrder, Replacement, etc.';