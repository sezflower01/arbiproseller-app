CREATE OR REPLACE FUNCTION public.get_monthly_cogs(p_year integer)
RETURNS TABLE(
  month_num integer,
  cogs numeric,
  units_sold bigint,
  units_with_cost bigint,
  units_missing_cost bigint,
  orders_missing_cost bigint,
  asins_missing_cost bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT make_date(p_year, 1, 1) AS start_d,
           make_date(p_year + 1, 1, 1) AS end_d
  ),
  base AS (
    SELECT
      s.order_id,
      s.asin,
      s.quantity,
      s.unit_cost,
      EXTRACT(MONTH FROM s.order_date)::int AS m
    FROM public.sales_orders s
    CROSS JOIN bounds b
    WHERE s.user_id = auth.uid()
      AND s.order_date >= b.start_d
      AND s.order_date <  b.end_d
      AND NOT s.order_id LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
  ),
  -- Contract A fallback: use created_listings if sales_orders.unit_cost is missing/zero
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
  enriched AS (
    SELECT
      b.m,
      b.order_id,
      b.asin,
      COALESCE(b.quantity, 1) AS qty,
      CASE
        WHEN COALESCE(b.unit_cost, 0) > 0 THEN b.unit_cost
        ELSE COALESCE(luc.unit_cost, 0)
      END AS effective_unit_cost
    FROM base b
    LEFT JOIN latest_unit_cost luc ON luc.asin = b.asin
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    COALESCE(SUM(e.effective_unit_cost * e.qty), 0)::numeric AS cogs,
    COALESCE(SUM(e.qty), 0)::bigint AS units_sold,
    COALESCE(SUM(CASE WHEN e.effective_unit_cost > 0 THEN e.qty ELSE 0 END), 0)::bigint AS units_with_cost,
    COALESCE(SUM(CASE WHEN e.effective_unit_cost > 0 THEN 0 ELSE e.qty END), 0)::bigint AS units_missing_cost,
    COALESCE(COUNT(DISTINCT CASE WHEN e.effective_unit_cost > 0 THEN NULL ELSE e.order_id END), 0)::bigint AS orders_missing_cost,
    COALESCE(COUNT(DISTINCT CASE WHEN e.effective_unit_cost > 0 THEN NULL ELSE NULLIF(e.asin, '') END), 0)::bigint AS asins_missing_cost
  FROM months
  LEFT JOIN enriched e ON e.m = months.m
  GROUP BY months.m
  ORDER BY months.m;
$function$;