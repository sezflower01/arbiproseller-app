-- Add status column to track pending vs settled orders
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS status text DEFAULT 'settled';

-- Add order_status column to track Amazon order status (Shipped, Cancelled, etc.)
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS order_status text DEFAULT NULL;

-- Add index for faster status queries
CREATE INDEX IF NOT EXISTS idx_sales_orders_status ON public.sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_sales_orders_order_status ON public.sales_orders(order_status);