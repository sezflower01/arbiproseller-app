UPDATE public.sales_orders
SET needs_fee_enrich = true,
    next_enrich_after = now()
WHERE fees_missing = true
  AND fees_source = 'unavailable'
  AND status != 'settled'
  AND (needs_fee_enrich IS DISTINCT FROM true)
  AND asin NOT IN ('PENDING', 'UNKNOWN')
  AND asin IS NOT NULL;