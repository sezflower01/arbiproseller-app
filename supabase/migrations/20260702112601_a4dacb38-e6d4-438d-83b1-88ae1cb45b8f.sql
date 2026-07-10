UPDATE public.sales_orders
SET estimated_price = bb_estimate_price,
    price_source = 'closest_bb_order_discovery',
    price_confidence = 'HIGH_CONFIDENCE_PENDING',
    needs_price_enrich = true,
    price_enrich_status = 'pending',
    price_last_error = NULL
WHERE order_id = '112-0881554-0409019'
  AND sold_price = 0
  AND bb_estimate_qualified = true
  AND bb_estimate_price > 0
  AND (price_confidence IS DISTINCT FROM 'CONFIRMED');