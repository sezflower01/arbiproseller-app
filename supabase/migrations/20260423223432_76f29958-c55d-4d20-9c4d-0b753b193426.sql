-- ============================================================================
-- Phase 4: Align period-totals SQL with Contract A (cost=TOTAL, amount=UNIT)
-- ============================================================================
-- Mirrors src/lib/cost-contract.ts :: getListingUnitCost
--   1. amount  (already the unit cost in Contract A)
--   2. cost / units  (derive unit from total)
--   3. 0  (insufficient data)
--
-- Removes the legacy `amount < 500` heuristic.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_settled_period_totals(
  start_ts timestamp with time zone,
  end_ts   timestamp with time zone
)
 RETURNS TABLE(
   sales numeric,
   refunds numeric,
   total_fees numeric,
   unique_orders bigint,
   refund_count bigint,
   row_count bigint,
   shipment_units bigint,
   cogs numeric,
   promotional_rebates_total numeric,
   shipping_credits_total numeric,
   gift_wrap_credits_total numeric
 )
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  base AS (
    SELECT *
    FROM public.financial_events_cache f
    CROSS JOIN bounds b
    WHERE f.user_id = auth.uid()
      AND f.event_date::date >= b.start_d
      AND f.event_date::date <  b.end_d
  ),
  shipment_counts AS (
    SELECT
      NULLIF(asin, '') AS asin,
      COUNT(*)::bigint AS units
    FROM base
    WHERE event_type = 'shipment'
    GROUP BY 1
  ),
  -- Contract A: amount = UNIT cost, cost = TOTAL batch cost
  -- Prefer amount, otherwise derive cost/units
  latest_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        WHEN COALESCE(amount, -1) >= 0 THEN amount
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        ELSE 0
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL
      AND asin <> ''
    ORDER BY asin, updated_at DESC
  )
  SELECT
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(sales, 0)) ELSE 0 END), 0) AS sales,
    COALESCE(SUM(CASE WHEN event_type = 'refund' THEN ABS(COALESCE(refunds, 0)) ELSE 0 END), 0) AS refunds,
    COALESCE(
      SUM(
        ABS(COALESCE(referral_fees, 0))
        + ABS(COALESCE(fba_fees, 0))
        + ABS(COALESCE(variable_closing_fees, 0))
        + ABS(COALESCE(fixed_closing_fees, 0))
        + ABS(COALESCE(fba_inbound_fees, 0))
        + ABS(COALESCE(fba_storage_fees, 0))
        + ABS(COALESCE(fba_removal_fees, 0))
        + ABS(COALESCE(fba_disposal_fees, 0))
        + ABS(COALESCE(fba_long_term_storage_fees, 0))
        + ABS(COALESCE(fba_customer_return_fees, 0))
        + ABS(COALESCE(other_fees, 0))
      ),
      0
    ) AS total_fees,
    COALESCE(COUNT(DISTINCT NULLIF(amazon_order_id, '')) FILTER (WHERE amazon_order_id NOT LIKE '%-REFUND%'), 0) AS unique_orders,
    COALESCE(COUNT(*) FILTER (WHERE event_type = 'refund'), 0) AS refund_count,
    COALESCE(COUNT(*), 0) AS row_count,
    COALESCE((SELECT SUM(units) FROM shipment_counts), 0) AS shipment_units,
    COALESCE(
      (
        SELECT SUM(sc.units * COALESCE(luc.unit_cost, 0))
        FROM shipment_counts sc
        LEFT JOIN latest_unit_cost luc ON luc.asin = sc.asin
      ),
      0
    ) AS cogs,
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(promotional_rebates, 0)) ELSE 0 END), 0) AS promotional_rebates_total,
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(shipping_credits, 0)) ELSE 0 END), 0) AS shipping_credits_total,
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(gift_wrap_credits, 0)) ELSE 0 END), 0) AS gift_wrap_credits_total
  FROM base;
$function$;


CREATE OR REPLACE FUNCTION public.get_sellerboard_period_totals(
  start_ts text,
  end_ts   text
)
 RETURNS TABLE(
   sales numeric,
   refunds numeric,
   total_fees numeric,
   unique_orders bigint,
   refund_count bigint,
   row_count bigint,
   total_units numeric,
   cogs numeric
 )
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  base AS (
    SELECT *,
      COALESCE(
        NULLIF(COALESCE(sold_price, 0), 0),
        NULLIF(COALESCE(estimated_price, 0), 0),
        0
      ) AS effective_price
    FROM public.sales_orders s
    CROSS JOIN bounds b
    WHERE s.user_id = auth.uid()
      AND s.order_date >= b.start_d
      AND s.order_date < b.end_d
      AND NOT s.order_id LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
  ),
  -- Contract A: amount = UNIT cost, cost = TOTAL batch cost
  latest_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        WHEN COALESCE(amount, -1) >= 0 THEN amount
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        ELSE 0
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL
      AND asin <> ''
    ORDER BY asin, updated_at DESC
  ),
  cogs_calc AS (
    SELECT SUM(
      COALESCE(b.unit_cost, luc.unit_cost, 0) * b.quantity
    ) AS total_cogs
    FROM base b
    LEFT JOIN latest_unit_cost luc ON luc.asin = b.asin
  )
  SELECT
    COALESCE(SUM(
      CASE WHEN COALESCE(total_sale_amount, 0) > 0 THEN total_sale_amount
           WHEN effective_price > 0 THEN effective_price * quantity
           ELSE 0
      END
    ), 0) AS sales,
    COALESCE(SUM(COALESCE(refund_amount, 0)), 0) AS refunds,
    COALESCE(SUM(COALESCE(total_fees, 0)), 0) AS total_fees,
    COALESCE(COUNT(DISTINCT NULLIF(order_id, '')), 0) AS unique_orders,
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(refund_amount, 0) > 0), 0) AS refund_count,
    COALESCE(COUNT(*), 0) AS row_count,
    COALESCE(SUM(COALESCE(quantity, 1)), 0) AS total_units,
    COALESCE((SELECT total_cogs FROM cogs_calc), 0) AS cogs
  FROM base;
$function$;