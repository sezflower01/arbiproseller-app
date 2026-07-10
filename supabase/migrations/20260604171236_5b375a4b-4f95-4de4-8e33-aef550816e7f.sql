UPDATE public.sales_orders
SET estimated_price = bb_estimate_price,
    price_source = 'closest_bb_order_discovery',
    price_confidence = 'HIGH_CONFIDENCE_PENDING',
    needs_price_enrich = true,
    price_enrich_status = 'pending',
    price_last_error = NULL
WHERE bb_estimate_qualified = true
  AND bb_estimate_price IS NOT NULL
  AND bb_estimate_price > 0
  AND COALESCE(sold_price, 0) = 0
  AND COALESCE(price_confidence, '') <> 'CONFIRMED'
  AND COALESCE(price_source, '') <> 'closest_bb_order_discovery';