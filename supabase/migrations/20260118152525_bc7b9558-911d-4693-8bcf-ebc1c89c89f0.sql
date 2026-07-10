-- One-time repair v2: populate estimated_price for Pending orders with missing price,
-- then apply asin_fee_cache fees (so these stop showing as "zero fees").

-- 1) Fill estimated_price from inventory (preferred)
UPDATE public.sales_orders so
SET
  estimated_price = ROUND(
    COALESCE(i.price, i.amazon_price, i.my_price)::numeric,
    2
  ),
  price_source = CASE
    WHEN i.price IS NOT NULL AND i.price > 0 THEN 'estimated:inventory.price'
    WHEN i.amazon_price IS NOT NULL AND i.amazon_price > 0 THEN 'estimated:inventory.amazon_price'
    WHEN i.my_price IS NOT NULL AND i.my_price > 0 THEN 'estimated:inventory.my_price'
    ELSE so.price_source
  END,
  price_calc_mode = 'estimated_repair',
  updated_at = now()
FROM public.inventory i
WHERE so.user_id = i.user_id
  AND so.asin = i.asin
  AND so.fees_missing = true
  AND (so.order_status = 'Pending' OR so.order_status IS NULL OR so.order_status = '')
  AND COALESCE(so.sold_price, 0) = 0
  AND COALESCE(so.estimated_price, 0) = 0
  AND COALESCE(i.price, i.amazon_price, i.my_price, 0) > 0
  AND so.order_date >= (CURRENT_DATE - INTERVAL '30 days');

-- 2) Apply cached fees now that estimated_price exists
UPDATE public.sales_orders so
SET
  referral_fee = ROUND((COALESCE(so.sold_price, so.estimated_price, 0) * fc.referral_rate)::numeric, 2),
  fba_fee = ROUND(fc.fba_fee_fixed::numeric, 2),
  closing_fee = CASE WHEN fc.is_media THEN 1.80 ELSE 0 END,
  total_fees = ROUND((
    (COALESCE(so.sold_price, so.estimated_price, 0) * fc.referral_rate)
    + fc.fba_fee_fixed
    + (CASE WHEN fc.is_media THEN 1.80 ELSE 0 END)
  )::numeric, 2),
  fees_source = 'repair_from_cache_v2',
  fees_missing = false,
  updated_at = now()
FROM public.asin_fee_cache fc
WHERE so.asin = fc.asin
  AND so.user_id = fc.user_id
  AND so.fees_missing = true
  AND COALESCE(so.sold_price, so.estimated_price, 0) > 0
  AND (fc.fba_fee_fixed > 0 OR fc.referral_rate > 0)
  AND so.order_date >= (CURRENT_DATE - INTERVAL '30 days');
