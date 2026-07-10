-- Cleanup: Delete roi_alerts records that were created for refunds/replacements before the fix
-- These have zero or negative revenue and should never have triggered alerts
DELETE FROM public.roi_alerts 
WHERE sales_total <= 0 
   OR array_to_string(order_ids, ',') ILIKE '%refund%';