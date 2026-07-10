CREATE OR REPLACE FUNCTION public.get_cogs_for_range(p_start date, p_end date)
RETURNS TABLE(total_cogs numeric, units_sold bigint, orders_with_cost bigint, total_orders bigint, cogs_by_source jsonb, units_by_source jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      s.asin,
      COALESCE(s.seller_sku, s.sku) AS sku,
      s.order_date,
      CASE
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale, 0) > 0 THEN s.unit_cost_at_sale
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost, 0) > 0 THEN s.unit_cost
        ELSE NULL::numeric
      END AS snapshot_cost,
      COALESCE(s.quantity, 1) AS qty
    FROM public.sales_orders s
    WHERE s.user_id = v_user
      AND s.order_date >= p_start
      AND s.order_date <= p_end
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
  ),
  resolved AS (
    SELECT b.qty, r.unit_cost, r.source
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_user, b.asin, b.sku, b.order_date, b.snapshot_cost) r
  ),
  by_source AS (
    SELECT
      source,
      SUM(unit_cost * qty)::numeric AS total_per_source,
      SUM(qty)::bigint AS units_per_source,
      COUNT(*) FILTER (WHERE unit_cost > 0)::bigint AS orders_with_source_cost,
      COUNT(*)::bigint AS orders_per_source
    FROM resolved
    GROUP BY source
  )
  SELECT
    COALESCE(SUM(total_per_source), 0)::numeric AS total_cogs,
    COALESCE((SELECT SUM(qty) FROM resolved), 0)::bigint AS units_sold,
    COALESCE(SUM(orders_with_source_cost), 0)::bigint AS orders_with_cost,
    COALESCE(SUM(orders_per_source), 0)::bigint AS total_orders,
    COALESCE(jsonb_object_agg(source, total_per_source), '{}'::jsonb) AS cogs_by_source,
    COALESCE(jsonb_object_agg(source, units_per_source), '{}'::jsonb) AS units_by_source
  FROM by_source;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_cogs_for_range(date, date) TO authenticated, service_role;

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
      ) AS effective_price,
      CASE
        WHEN cost_locked = true AND COALESCE(unit_cost_at_sale, 0) > 0 THEN unit_cost_at_sale
        WHEN cost_locked = true AND COALESCE(unit_cost, 0) > 0 THEN unit_cost
        ELSE NULL::numeric
      END AS locked_snapshot_cost
    FROM public.sales_orders s
    CROSS JOIN bounds b
    WHERE s.user_id = auth.uid()
      AND s.order_date >= b.start_d
      AND s.order_date < b.end_d
      AND NOT s.order_id LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
  ),
  cogs_calc AS (
    SELECT SUM(r.unit_cost * COALESCE(b.quantity, 1)) AS total_cogs
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      auth.uid(),
      b.asin,
      COALESCE(b.seller_sku, b.sku),
      b.order_date,
      b.locked_snapshot_cost
    ) r
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

GRANT EXECUTE ON FUNCTION public.get_sellerboard_period_totals(text, text) TO authenticated, service_role;