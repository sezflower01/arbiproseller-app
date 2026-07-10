-- Update get_sellerboard_period_totals to exclude pending/unshipped orders (match Excel export logic)
-- This ensures the "Month to date" block matches the Excel export exactly

DROP FUNCTION IF EXISTS public.get_sellerboard_period_totals(timestamp with time zone, timestamp with time zone);

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
  -- Base query: sales_orders by purchase date (order_date), excluding refund rows AND pending orders
  -- MATCH EXCEL EXPORT: Only include settled/shipped orders (exclude Pending/Unshipped)
  base AS (
    SELECT *
    FROM public.sales_orders s
    CROSS JOIN bounds b
    WHERE s.user_id = auth.uid()
      AND s.order_date >= b.start_d
      AND s.order_date < b.end_d
      AND NOT s.order_id LIKE '%-REFUND'
      -- Exclude cancelled orders (both string status and boolean flag)
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      -- CRITICAL: Exclude pending/unshipped orders to match Excel export
      AND COALESCE(s.order_status, '') NOT IN ('Pending', 'Unshipped', 'PendingAvailability', 'PartiallyShipped')
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
    -- Unique orders (deduplicate by order_id to avoid counting multi-ASIN orders multiple times)
    COALESCE(COUNT(DISTINCT NULLIF(order_id, '')), 0) AS unique_orders,
    -- Refund count (orders with refund_amount > 0)
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(refund_amount, 0) > 0), 0) AS refund_count,
    -- Row count
    COALESCE(COUNT(*), 0) AS row_count,
    -- Total units (actual quantity from Orders API) - this is now NET units (no refund rows included)
    COALESCE(SUM(COALESCE(quantity, 1)), 0) AS total_units,
    -- COGS from calculation
    COALESCE((SELECT total_cogs FROM cogs_calc), 0) AS cogs
  FROM base;
$function$;