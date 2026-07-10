-- Delete placeholder records that were never updated with real order data
-- These have asin = 'PENDING' and title = 'Order Processing...'
DELETE FROM sales_orders 
WHERE asin = 'PENDING' OR title = 'Order Processing...';