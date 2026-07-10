UPDATE public.sales_orders
SET estimated_price = NULL,
    price_source = NULL,
    price_calc_mode = NULL,
    updated_at = now()
WHERE price_source IN (
  'estimated:asin_my_price_cache',
  'estimated:inventory.price',
  'estimated:inventory.amazon_price',
  'estimated:inventory.my_price',
  'estimated:inventory'
)
AND marketplace NOT IN ('US','ATVPDKIKX0DER')
AND (sold_price IS NULL OR sold_price = 0)
AND (total_sale_amount IS NULL OR total_sale_amount = 0);