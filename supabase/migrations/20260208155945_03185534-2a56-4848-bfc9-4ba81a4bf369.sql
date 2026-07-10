-- Clean up all $0 refund records from sales_orders
-- These are Amazon replacement/goodwill events with no financial impact
DELETE FROM sales_orders 
WHERE order_id LIKE '%-REFUND' 
AND (refund_amount = 0 OR refund_amount IS NULL);