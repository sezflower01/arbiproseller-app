CREATE OR REPLACE FUNCTION public.get_fec_daily_shipment_totals(
  p_start date,
  p_end date,
  p_marketplace text DEFAULT NULL
)
RETURNS TABLE(
  event_day date,
  marketplace text,
  units bigint,
  sales numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    f.event_date::date AS event_day,
    COALESCE(f.marketplace, 'US') AS marketplace,
    COUNT(*)::bigint AS units,
    COALESCE(SUM(ABS(COALESCE(f.sales, 0))), 0)::numeric AS sales
  FROM public.financial_events_cache f
  WHERE f.user_id = auth.uid()
    AND f.event_type = 'shipment'
    AND f.event_date >= p_start
    AND f.event_date <= p_end
    AND (p_marketplace IS NULL OR f.marketplace = p_marketplace)
  GROUP BY 1, 2;
$function$;