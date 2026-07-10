-- Fix all remaining zero-price pending orders for B0FDGZZXV2
UPDATE sales_orders 
SET 
  sold_price = 27.75,
  total_sale_amount = quantity * 27.75,
  price_source = 'manual_fix'
WHERE asin = 'B0FDGZZXV2' 
  AND sold_price = 0
  AND status = 'pending';