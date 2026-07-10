-- RPC: settled period totals from financial_events_cache using half-open [start, end) date logic
-- This avoids Supabase 1000-row limits and prevents client-side summing drift.
CREATE OR REPLACE FUNCTION public.get_settled_period_totals(
  start_ts timestamptz,
  end_ts timestamptz
)
RETURNS TABLE (
  sales numeric,
  refunds numeric,
  total_fees numeric,
  unique_orders bigint,
  refund_count bigint,
  row_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
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
    COALESCE(COUNT(*), 0) AS row_count
  FROM public.financial_events_cache f
  CROSS JOIN bounds b
  WHERE f.user_id = auth.uid()
    AND f.event_date::date >= b.start_d
    AND f.event_date::date <  b.end_d;
$$;