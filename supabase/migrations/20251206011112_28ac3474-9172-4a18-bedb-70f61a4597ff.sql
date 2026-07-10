-- Update existing refund records to pending status so they show on Sales page
UPDATE public.sales_orders 
SET status = 'pending', updated_at = now()
WHERE order_id LIKE '%-REFUND' AND status = 'settled';