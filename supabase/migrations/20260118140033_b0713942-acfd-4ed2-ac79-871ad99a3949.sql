-- Recalculate fees for migrated pending orders using estimated_price and asin_fee_cache
UPDATE public.sales_orders so
SET 
  referral_fee = COALESCE(so.estimated_price, 0) * fc.referral_rate,
  fba_fee = fc.fba_fee_fixed,
  closing_fee = CASE WHEN fc.is_media THEN 1.80 ELSE 0 END,
  total_fees = fc.fba_fee_fixed + (COALESCE(so.estimated_price, 0) * fc.referral_rate) + (CASE WHEN fc.is_media THEN 1.80 ELSE 0 END),
  fees_source = 'fee_cache_recalc',
  updated_at = now()
FROM public.asin_fee_cache fc
WHERE so.asin = fc.asin 
AND so.user_id = fc.user_id
AND so.order_status = 'Pending'
AND so.price_source LIKE 'estimated:%'
AND so.estimated_price > 0
AND (so.total_fees = 0 OR so.total_fees IS NULL OR so.referral_fee = 0 OR so.referral_fee IS NULL)