-- Add columns for order status refresh tracking
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS is_cancelled boolean DEFAULT false;

ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS cancelled_at timestamp with time zone DEFAULT NULL;

ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS last_status_sync_at timestamp with time zone DEFAULT NULL;

ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS status_source text DEFAULT NULL;

-- Index for faster cancelled order filtering
CREATE INDEX IF NOT EXISTS idx_sales_orders_is_cancelled ON public.sales_orders(is_cancelled);

-- Index for status refresh targeting (stale pending orders)
CREATE INDEX IF NOT EXISTS idx_sales_orders_status_sync ON public.sales_orders(last_status_sync_at) 
WHERE status = 'pending' AND is_cancelled = false;