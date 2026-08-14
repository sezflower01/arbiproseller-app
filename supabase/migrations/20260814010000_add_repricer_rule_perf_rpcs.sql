-- Supports repricer-rule-performance edge function. The direct-table
-- pagination approach timed out in production: repricer_price_actions is
-- extremely high volume for this account (confirmed ~1000+ rows for a
-- single ASIN over 11 days), so pulling every row through the edge function
-- to filter client-side for "is this a raise" is not viable. Do the filter,
-- join, and aggregation in Postgres instead, which can use normal query
-- planning rather than paging the whole table through PostgREST.

CREATE OR REPLACE FUNCTION public.repricer_rule_perf_sales(p_user_id uuid, p_since timestamptz)
RETURNS TABLE(
  smart_profile text,
  order_day date,
  units bigint,
  revenue numeric,
  cost numeric,
  fees numeric,
  order_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(rr.smart_profile, 'CUSTOM') AS smart_profile,
    so.order_date::date AS order_day,
    SUM(so.quantity)::bigint AS units,
    SUM(COALESCE(so.total_sale_amount, 0)) AS revenue,
    SUM(COALESCE(so.total_cost, 0)) AS cost,
    SUM(COALESCE(so.total_fees, 0)) AS fees,
    COUNT(*)::bigint AS order_count
  FROM sales_orders so
  JOIN repricer_assignments ra
    ON ra.user_id = so.user_id AND ra.asin = so.asin AND ra.sku = so.sku AND ra.marketplace = so.marketplace
  JOIN repricer_rules rr ON rr.id = ra.rule_id
  WHERE so.user_id = p_user_id
    AND so.order_date >= p_since
    AND so.is_cancelled = false
    AND ra.rule_id IS NOT NULL
  GROUP BY 1, 2
$$;

-- Pushes the "is this a raise" filter and the recency LIMIT into Postgres,
-- instead of paging the entire price-action history through the edge
-- function only to discard most rows client-side.
CREATE OR REPLACE FUNCTION public.repricer_rule_perf_raises(p_user_id uuid, p_since timestamptz, p_limit int DEFAULT 500)
RETURNS TABLE(
  asin text,
  sku text,
  marketplace text,
  old_price numeric,
  new_price numeric,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT asin, sku, marketplace, old_price, new_price, created_at
  FROM repricer_price_actions
  WHERE user_id = p_user_id
    AND created_at >= p_since
    AND new_price IS NOT NULL
    AND old_price IS NOT NULL
    AND new_price > old_price
  ORDER BY created_at DESC
  LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION public.repricer_rule_perf_sales(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repricer_rule_perf_raises(uuid, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repricer_rule_perf_sales(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.repricer_rule_perf_raises(uuid, timestamptz, int) TO service_role;
