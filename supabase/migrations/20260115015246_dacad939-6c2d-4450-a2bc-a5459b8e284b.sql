-- Create authoritative period totals RPC that uses the SAME COGS logic as the Sales table
-- This ensures all blocks show consistent COGS without needing to be "selected"

CREATE OR REPLACE FUNCTION public.get_authoritative_period_totals(
  start_ts timestamp with time zone, 
  end_ts timestamp with time zone
)
RETURNS TABLE(
  sales numeric,
  refunds numeric,
  total_fees numeric,
  unique_orders bigint,
  refund_count bigint,
  row_count bigint,
  total_units bigint,
  cogs numeric,
  promotional_rebates_total numeric,
  shipping_credits_total numeric,
  gift_wrap_credits_total numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  -- Base: financial_events_cache for settled data (same as get_settled_period_totals)
  base AS (
    SELECT *
    FROM public.financial_events_cache f
    CROSS JOIN bounds b
    WHERE f.user_id = auth.uid()
      AND f.event_date::date >= b.start_d
      AND f.event_date::date <  b.end_d
  ),
  -- Count units per ASIN from shipments
  shipment_counts AS (
    SELECT
      NULLIF(asin, '') AS asin,
      COUNT(*)::bigint AS units
    FROM base
    WHERE event_type = 'shipment'
    GROUP BY 1
  ),
  -- AUTHORITATIVE UNIT COST: Same logic as Sales table
  -- Priority: created_listings (cost/units or amount) > sales_orders.unit_cost
  latest_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        -- Primary: cost/units calculation (most reliable)
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        -- Fallback: amount field if valid and under $500 (guards against garbage data)
        WHEN COALESCE(amount, 0) > 0 AND COALESCE(amount, 0) < 500 THEN amount
        -- Last resort: treat cost as unit cost if it's reasonable
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(cost, 0) < 500 THEN cost
        ELSE 0
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL
      AND asin <> ''
    ORDER BY asin, updated_at DESC
  ),
  -- Secondary fallback: sales_orders.unit_cost for ASINs not in created_listings
  sales_orders_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      COALESCE(unit_cost, 0) AS unit_cost
    FROM public.sales_orders
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL
      AND asin <> ''
      AND unit_cost IS NOT NULL
      AND unit_cost > 0
    ORDER BY asin, updated_at DESC
  ),
  -- Combine: created_listings first, then sales_orders fallback
  authoritative_cost AS (
    SELECT
      sc.asin,
      sc.units,
      COALESCE(
        NULLIF(luc.unit_cost, 0),
        soc.unit_cost,
        0
      ) AS unit_cost
    FROM shipment_counts sc
    LEFT JOIN latest_unit_cost luc ON luc.asin = sc.asin
    LEFT JOIN sales_orders_cost soc ON soc.asin = sc.asin
  )
  SELECT
    -- Gross Sales = Principal only (same as get_settled_period_totals)
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
    COALESCE((SELECT SUM(units) FROM shipment_counts), 0) AS total_units,
    -- AUTHORITATIVE COGS: uses created_listings > sales_orders fallback
    COALESCE(
      (
        SELECT SUM(ac.units * ac.unit_cost)
        FROM authoritative_cost ac
      ),
      0
    ) AS cogs,
    -- Promotional rebates (coupons, discounts)
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(promotional_rebates, 0)) ELSE 0 END), 0) AS promotional_rebates_total,
    -- Shipping credits (revenue)
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(shipping_credits, 0)) ELSE 0 END), 0) AS shipping_credits_total,
    -- Gift wrap credits (revenue)
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(gift_wrap_credits, 0)) ELSE 0 END), 0) AS gift_wrap_credits_total
  FROM base;
$$;