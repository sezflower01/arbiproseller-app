-- Mark remaining intl pending rows (listings_api/pricing_api estimates, no real ItemPrice) as retryable
UPDATE public.sales_orders
SET needs_price_enrich = true,
    updated_at = now()
WHERE marketplace IN ('CA','MX','BR')
  AND (price_source LIKE 'listings_api%' OR price_source LIKE 'pricing_api%')
  AND (sold_price IS NULL OR sold_price = 0)
  AND status NOT IN ('cancelled','canceled')
  AND (order_status IS NULL OR order_status NOT ILIKE 'cancel%');