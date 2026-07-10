UPDATE public.sales_orders
SET
  sold_price = 29.99,
  item_price = 29.99,
  total_sale_amount = 29.99,
  estimated_price = 31.49,
  price_source = 'orders_itemprice',
  price_calc_mode = 'orders_itemprice',
  needs_price_enrich = false,
  price_enrich_status = 'enriched',
  next_enrich_after = NULL,
  last_enrich_error = NULL,
  pending_enrich_last_error = NULL,
  updated_at = now()
WHERE order_id = '111-9320652-5453822'
  AND asin = 'B01D0BD8CM';