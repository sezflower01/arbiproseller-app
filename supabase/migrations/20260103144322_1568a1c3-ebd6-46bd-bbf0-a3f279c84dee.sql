-- Fix the incorrectly detected marketplace for order 701-9153953-9229862
-- This was a Mexico order but was incorrectly set as CA (Canada)
UPDATE public.sales_orders 
SET marketplace = 'MX', updated_at = now()
WHERE order_id = '701-9153953-9229862';