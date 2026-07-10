
UPDATE public.sales_orders
SET
  sold_price = 0,
  item_price = 0,
  total_sale_amount = 0,
  estimated_price = NULL,
  locked_est_price = NULL,
  price_locked_at = NULL,
  locked_from = NULL,
  price_source = NULL,
  price_calc_mode = NULL,
  needs_price_enrich = true,
  price_enrich_status = 'pending',
  enrich_attempts = 0,
  pending_enrich_attempts = 0,
  next_enrich_after = NULL,
  last_enrich_error = NULL,
  pending_enrich_last_error = NULL,
  updated_at = now()
WHERE order_id = '111-9320652-5453822'
  AND asin = 'B01D0BD8CM';
