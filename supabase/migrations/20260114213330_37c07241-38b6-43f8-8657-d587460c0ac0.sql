-- Fix the get_settled_period_totals function
-- Shipping Credits and Gift Wrap are REVENUE (added to sales), not deductions
-- Promotional Rebates ARE deductions (coupons/discounts given to buyers)
-- Net Sales = Principal - Promotional Rebates (Sellerboard-style)

DROP FUNCTION IF EXISTS public.get_settled_period_totals(timestamp with time zone, timestamp with time zone);

CREATE OR REPLACE FUNCTION public.get_settled_period_totals(start_ts timestamp with time zone, end_ts timestamp with time zone)
 RETURNS TABLE(
   sales numeric, 
   refunds numeric, 
   total_fees numeric, 
   unique_orders bigint, 
   refund_count bigint, 
   row_count bigint, 
   shipment_units bigint, 
   cogs numeric,
   -- Net Sales breakdown (Sellerboard-style)
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
  latest_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        WHEN COALESCE(amount, 0) > 0 AND COALESCE(amount, 0) < 500 THEN amount
        ELSE 0
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL
      AND asin <> ''
    ORDER BY asin, updated_at DESC
  )
  SELECT
    -- Gross Sales = Principal only (Sellerboard shows this as "Sales")
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
    -- Promotional rebates (coupons, discounts) - THIS is a real deduction from Sales
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(promotional_rebates, 0)) ELSE 0 END), 0) AS promotional_rebates_total,
    -- Shipping credits - REVENUE, not a deduction (customer paid for shipping)
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(shipping_credits, 0)) ELSE 0 END), 0) AS shipping_credits_total,
    -- Gift wrap credits - REVENUE, not a deduction (customer paid for gift wrap)
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(gift_wrap_credits, 0)) ELSE 0 END), 0) AS gift_wrap_credits_total
  FROM base;
$function$;