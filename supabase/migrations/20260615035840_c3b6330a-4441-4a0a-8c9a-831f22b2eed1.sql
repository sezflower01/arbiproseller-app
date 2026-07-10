-- Backfill replacement detection for legacy rows that pre-date the writer change.
-- Rule: Shipped + AFN + zero principal (sold_price = 0 OR NULL AND total_sale_amount = 0 OR NULL)
-- AND not cancelled AND quantity > 0  →  heuristic_zero_price_afn.
-- This mirrors the runtime rule already in sync-sales-orders / fetch-live-orders
-- ("fec_zero_principal_shipped") so historical YTD totals match new orders.
WITH candidates AS (
  SELECT id, user_id, order_id, asin, quantity, unit_cost
  FROM public.sales_orders
  WHERE is_replacement IS NOT TRUE
    AND order_status = 'Shipped'
    AND (fulfillment_channel ILIKE 'AFN%' OR fulfillment_channel IS NULL)
    AND COALESCE(sold_price, 0) = 0
    AND COALESCE(total_sale_amount, 0) = 0
    AND COALESCE(quantity, 0) > 0
    AND COALESCE(is_cancelled, false) = false
)
, updated AS (
  UPDATE public.sales_orders s
  SET is_replacement = true,
      replacement_reason = COALESCE(replacement_reason, 'heuristic_zero_price_afn'),
      price_confidence = 'REPLACEMENT_ZERO_REVENUE',
      needs_price_enrich = false
  FROM candidates c
  WHERE s.id = c.id
  RETURNING s.id, s.user_id, s.order_id, s.asin, s.quantity, s.unit_cost
)
INSERT INTO public.replacement_detection_audit
  (user_id, order_id, asin, detection_source, prior_is_replacement, prior_sold_price, quantity, unit_cost, cogs_impact, details)
SELECT 
  u.user_id, u.order_id, u.asin, 'backfill_heuristic_zero_price_afn',
  false, 0,
  u.quantity, u.unit_cost,
  COALESCE(u.unit_cost, 0) * COALESCE(u.quantity, 1),
  jsonb_build_object('source','backfill','rule','shipped_afn_zero_principal')
FROM updated u;