UPDATE public.sales_orders so
SET
  estimated_price = 89.77,
  price_source = 'created_listing_pending_estimate',
  price_confidence = 'HIGH_CONFIDENCE_PENDING',
  needs_price_enrich = true,
  price_enrich_status = 'pending',
  referral_fee = ROUND((89.77 * COALESCE((
    SELECT afc.referral_rate
    FROM public.asin_fee_cache afc
    WHERE afc.user_id = so.user_id
      AND afc.asin = so.asin
      AND afc.marketplace = COALESCE(NULLIF(so.marketplace, ''), 'US')
    ORDER BY afc.updated_at DESC
    LIMIT 1
  ), 0.15) * GREATEST(COALESCE(so.quantity, 1), 1))::numeric, 2),
  fba_fee = ROUND((COALESCE((
    SELECT afc.fba_fee_fixed
    FROM public.asin_fee_cache afc
    WHERE afc.user_id = so.user_id
      AND afc.asin = so.asin
      AND afc.marketplace = COALESCE(NULLIF(so.marketplace, ''), 'US')
    ORDER BY afc.updated_at DESC
    LIMIT 1
  ), 0) * GREATEST(COALESCE(so.quantity, 1), 1))::numeric, 2),
  closing_fee = 0,
  total_fees = ROUND(((89.77 * COALESCE((
    SELECT afc.referral_rate
    FROM public.asin_fee_cache afc
    WHERE afc.user_id = so.user_id
      AND afc.asin = so.asin
      AND afc.marketplace = COALESCE(NULLIF(so.marketplace, ''), 'US')
    ORDER BY afc.updated_at DESC
    LIMIT 1
  ), 0.15) + COALESCE((
    SELECT afc.fba_fee_fixed
    FROM public.asin_fee_cache afc
    WHERE afc.user_id = so.user_id
      AND afc.asin = so.asin
      AND afc.marketplace = COALESCE(NULLIF(so.marketplace, ''), 'US')
    ORDER BY afc.updated_at DESC
    LIMIT 1
  ), 0)) * GREATEST(COALESCE(so.quantity, 1), 1))::numeric, 2),
  unit_cost = 50.096,
  total_cost = ROUND((50.096 * GREATEST(COALESCE(so.quantity, 1), 1))::numeric, 2),
  roi = ROUND((((89.77 * GREATEST(COALESCE(so.quantity, 1), 1)) - ROUND(((89.77 * COALESCE((
    SELECT afc.referral_rate
    FROM public.asin_fee_cache afc
    WHERE afc.user_id = so.user_id
      AND afc.asin = so.asin
      AND afc.marketplace = COALESCE(NULLIF(so.marketplace, ''), 'US')
    ORDER BY afc.updated_at DESC
    LIMIT 1
  ), 0.15) + COALESCE((
    SELECT afc.fba_fee_fixed
    FROM public.asin_fee_cache afc
    WHERE afc.user_id = so.user_id
      AND afc.asin = so.asin
      AND afc.marketplace = COALESCE(NULLIF(so.marketplace, ''), 'US')
    ORDER BY afc.updated_at DESC
    LIMIT 1
  ), 0)) * GREATEST(COALESCE(so.quantity, 1), 1))::numeric, 2) - (50.096 * GREATEST(COALESCE(so.quantity, 1), 1))) / NULLIF((50.096 * GREATEST(COALESCE(so.quantity, 1), 1)), 0) * 100)::numeric, 1),
  fees_source = COALESCE((
    SELECT afc.fee_source
    FROM public.asin_fee_cache afc
    WHERE afc.user_id = so.user_id
      AND afc.asin = so.asin
      AND afc.marketplace = COALESCE(NULLIF(so.marketplace, ''), 'US')
    ORDER BY afc.updated_at DESC
    LIMIT 1
  ), 'estimated_from_listing'),
  fees_missing = false,
  updated_at = now()
WHERE so.user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND so.order_id = '112-1623440-3264228'
  AND so.asin = 'B0BMTMQTW5'
  AND COALESCE(so.sold_price, 0) = 0
  AND COALESCE(so.total_sale_amount, 0) = 0;