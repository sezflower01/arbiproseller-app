-- Fix corrupted estimated_price: MXN price was stored as USD for order 114-9366653-7049806
-- The correct USD price from asin_my_price_cache (US marketplace) is $30.23
UPDATE public.sales_orders
SET estimated_price = 30.23,
    price_source = 'estimated:asin_my_price_cache_fixed',
    updated_at = now()
WHERE id = '0acd0f42-8efb-431e-bffb-12c8e6137b02'
  AND estimated_price = 706.77;