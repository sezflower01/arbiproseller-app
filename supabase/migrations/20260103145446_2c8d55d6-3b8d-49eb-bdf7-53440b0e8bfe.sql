-- Fix the sold price for order 114-4073317-1011442 which was missing the ShippingPrice
-- User confirmed actual sold price was $16.70 (shipping included)
UPDATE public.sales_orders 
SET 
  sold_price = 16.70,
  total_sale_amount = 16.70,
  updated_at = now()
WHERE order_id = '114-4073317-1011442' AND asin = 'B0CFF4C9DC';