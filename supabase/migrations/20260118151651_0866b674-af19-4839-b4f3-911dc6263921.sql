
-- One-time repair: Apply cached fees to orders with fees_missing=true
-- This fixes the backlog of orders that have valid fee cache entries
UPDATE public.sales_orders so
SET 
  referral_fee = ROUND((COALESCE(so.sold_price, so.estimated_price, 0) * fc.referral_rate)::numeric, 2),
  fba_fee = ROUND(fc.fba_fee_fixed::numeric, 2),
  closing_fee = CASE WHEN fc.is_media THEN 1.80 ELSE 0 END,
  total_fees = ROUND((
    (COALESCE(so.sold_price, so.estimated_price, 0) * fc.referral_rate) + 
    fc.fba_fee_fixed + 
    (CASE WHEN fc.is_media THEN 1.80 ELSE 0 END)
  )::numeric, 2),
  fees_source = 'repair_from_cache',
  fees_missing = false,
  updated_at = now()
FROM public.asin_fee_cache fc
WHERE so.asin = fc.asin 
AND so.user_id = fc.user_id
AND so.fees_missing = true
AND (fc.fba_fee_fixed > 0 OR fc.referral_rate > 0)
AND COALESCE(so.sold_price, so.estimated_price, 0) > 0
