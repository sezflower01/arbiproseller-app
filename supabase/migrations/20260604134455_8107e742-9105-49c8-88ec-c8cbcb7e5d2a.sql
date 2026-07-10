UPDATE public.sales_orders
SET bb_estimate_price = NULL
WHERE bb_estimate_owner_match IS FALSE
  AND bb_estimate_price IS NOT NULL;