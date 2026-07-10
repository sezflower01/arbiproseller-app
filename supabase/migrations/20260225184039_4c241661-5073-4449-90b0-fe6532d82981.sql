CREATE OR REPLACE FUNCTION public.get_sellerboard_period_totals(start_ts text, end_ts text)
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
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  -- Base query: sales_orders by purchase date (order_date)
  -- MATCH BLOCKS: Only include orders with settled financial data (sold_price > 0 OR total_sale_amount > 0)
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
      -- FIXED: Exclude ALL orders without settled financial data, regardless of status
      -- This prevents shipped-but-unsettled orders from inflating gross profit
      AND (COALESCE(s.sold_price, 0) > 0 OR COALESCE(s.total_sale_amount, 0) > 0)
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
    COALESCE(SUM(total_sale_amount), 0) AS sales,
    COALESCE(SUM(COALESCE(refund_amount, 0)), 0) AS refunds,
    COALESCE(SUM(COALESCE(total_fees, 0)), 0) AS total_fees,
    COALESCE(COUNT(DISTINCT NULLIF(order_id, '')), 0) AS unique_orders,
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(refund_amount, 0) > 0), 0) AS refund_count,
    COALESCE(COUNT(*), 0) AS row_count,
    COALESCE(SUM(COALESCE(quantity, 1)), 0) AS total_units,
    COALESCE((SELECT total_cogs FROM cogs_calc), 0) AS cogs
  FROM base;
$$;