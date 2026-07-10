UPDATE public.sales_orders
SET needs_price_enrich = true,
    next_enrich_after = NOW(),
    enrich_attempts = COALESCE(enrich_attempts, 0)
WHERE (sold_price IS NULL OR sold_price = 0)
  AND (total_sale_amount IS NULL OR total_sale_amount = 0)
  AND (estimated_price IS NULL OR estimated_price = 0)
  AND needs_price_enrich = false
  AND order_status IN ('Pending','Unshipped','PartiallyShipped')
  AND order_date >= (CURRENT_DATE - INTERVAL '14 days');