
-- Fix get_sellerboard_period_totals (text, text) to include ALL orders (Purchase Date model)
CREATE OR REPLACE FUNCTION public.get_sellerboard_period_totals(start_ts text, end_ts text)
 RETURNS TABLE(sales numeric, refunds numeric, total_fees numeric, unique_orders bigint, refund_count bigint, row_count bigint, total_units numeric, cogs numeric)
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
           ELSE effective_price * quantity
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

-- Fix get_sellerboard_period_totals (timestamptz, timestamptz) to include ALL orders
CREATE OR REPLACE FUNCTION public.get_sellerboard_period_totals(start_ts timestamp with time zone, end_ts timestamp with time zone)
 RETURNS TABLE(sales numeric, refunds numeric, total_fees numeric, unique_orders bigint, refund_count bigint, row_count bigint, total_units bigint, cogs numeric)
 LANGUAGE sql
 STABLE
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
           ELSE effective_price * quantity
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
