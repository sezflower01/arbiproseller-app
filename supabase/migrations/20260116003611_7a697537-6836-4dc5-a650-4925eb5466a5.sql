-- Fix the pending order with missing price data
-- Item price is ~$27.75 per unit, so 2 units = ~$55.50
UPDATE sales_orders 
SET 
  sold_price = 27.75,
  total_sale_amount = 55.50,
  price_source = 'manual_fix'
WHERE order_id = '111-0187363-4865071' 
  AND asin = 'B0FDGZZXV2'
  AND sold_price = 0;