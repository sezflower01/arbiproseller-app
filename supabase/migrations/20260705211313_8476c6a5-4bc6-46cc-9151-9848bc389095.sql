
CREATE OR REPLACE FUNCTION public.get_fec_month_counts(
  p_user_id UUID,
  p_start_date DATE,
  p_end_date DATE
)
RETURNS TABLE (
  month_key TEXT,
  total_cnt BIGINT,
  ship_cnt BIGINT,
  sf_cnt BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    to_char(date_trunc('month', event_date), 'YYYY-MM') AS month_key,
    count(*) AS total_cnt,
    count(*) FILTER (WHERE event_type = 'shipment') AS ship_cnt,
    count(*) FILTER (WHERE event_type = 'service_fee') AS sf_cnt
  FROM public.financial_events_cache
  WHERE user_id = p_user_id
    AND event_date >= p_start_date
    AND event_date <= p_end_date
  GROUP BY 1
  ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_fec_month_counts(UUID, DATE, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_fec_month_counts(UUID, DATE, DATE) IS
  'Sprint 1.1: Returns per-month FEC row counts (total, shipment, service_fee) in ONE round-trip. Replaces 36 parallel PostgREST count-exact HTTP calls in fetch-profit-loss.isMonthCached which produced 7-25s tail-latency spikes on shared PostgREST pool. Classification (cached vs partial) stays in edge function.';
