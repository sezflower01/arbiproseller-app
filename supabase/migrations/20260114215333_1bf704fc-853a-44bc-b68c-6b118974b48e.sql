
-- Fix the get_sellerboard_period_totals RPC to use sales_orders.unit_cost (primary) 
-- and fall back to created_listings only when unit_cost is null
CREATE OR REPLACE FUNCTION public.get_sellerboard_period_totals(start_ts timestamp with time zone, end_ts timestamp with time zone)
 RETURNS TABLE(
   sales numeric,
   refunds numeric,
   total_fees numeric,
   unique_orders bigint,
   refund_count bigint,
   row_count bigint,
   total_units bigint,
   cogs numeric
 )
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  -- Base query: sales_orders by purchase date (order_date), excluding refund rows
  base AS (
    SELECT *
    FROM public.sales_orders s
    CROSS JOIN bounds b
    WHERE s.user_id = auth.uid()
      AND s.order_date >= b.start_d
      AND s.order_date < b.end_d
      AND NOT s.order_id LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
  ),
  -- Get latest unit cost from created_listings as fallback
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
  ),
  -- Calculate COGS using sales_orders.unit_cost first, then fallback to created_listings
  cogs_calc AS (
    SELECT SUM(
      COALESCE(b.unit_cost, luc.unit_cost, 0) * b.quantity
    ) AS total_cogs
    FROM base b
    LEFT JOIN latest_unit_cost luc ON luc.asin = b.asin
  )
  SELECT
    -- Gross Sales (total_sale_amount which is ItemPrice from Orders API)
    COALESCE(SUM(total_sale_amount), 0) AS sales,
    -- Refunds (from refund_amount column)
    COALESCE(SUM(COALESCE(refund_amount, 0)), 0) AS refunds,
    -- Total fees
    COALESCE(SUM(COALESCE(total_fees, 0)), 0) AS total_fees,
    -- Unique orders
    COALESCE(COUNT(DISTINCT NULLIF(order_id, '')), 0) AS unique_orders,
    -- Refund count (orders with refund_amount > 0)
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(refund_amount, 0) > 0), 0) AS refund_count,
    -- Row count
    COALESCE(COUNT(*), 0) AS row_count,
    -- Total units (actual quantity from Orders API)
    COALESCE(SUM(COALESCE(quantity, 1)), 0) AS total_units,
    -- COGS from calculation
    COALESCE((SELECT total_cogs FROM cogs_calc), 0) AS cogs
  FROM base;
$function$;
