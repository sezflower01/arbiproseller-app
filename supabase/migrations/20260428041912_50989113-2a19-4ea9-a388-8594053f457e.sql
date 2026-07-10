CREATE OR REPLACE FUNCTION public.get_year_cache_status(p_year integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH month_breakdown AS (
    SELECT
      EXTRACT(MONTH FROM event_date)::int AS m,
      COUNT(*)::int AS total_cnt,
      COUNT(*) FILTER (WHERE event_type = 'shipment')::int    AS shipment_cnt,
      COUNT(*) FILTER (WHERE event_type = 'refund')::int      AS refund_cnt,
      COUNT(*) FILTER (WHERE event_type = 'service_fee')::int AS service_fee_cnt,
      COUNT(*) FILTER (WHERE event_type = 'adjustment')::int  AS adjustment_cnt,
      COUNT(*) FILTER (WHERE event_type = 'removal')::int     AS removal_cnt,
      COUNT(*) FILTER (WHERE event_type = 'liquidation')::int AS liquidation_cnt
    FROM public.financial_events_cache
    WHERE user_id = auth.uid()
      AND event_date >= make_date(p_year, 1, 1)
      AND event_date <  make_date(p_year + 1, 1, 1)
    GROUP BY 1
  ),
  all_months AS (SELECT generate_series(1, 12) AS m),
  merged AS (
    SELECT
      a.m,
      COALESCE(mb.total_cnt, 0)       AS total_cnt,
      COALESCE(mb.shipment_cnt, 0)    AS shipment_cnt,
      COALESCE(mb.refund_cnt, 0)      AS refund_cnt,
      COALESCE(mb.service_fee_cnt, 0) AS service_fee_cnt,
      COALESCE(mb.adjustment_cnt, 0)  AS adjustment_cnt,
      COALESCE(mb.removal_cnt, 0)     AS removal_cnt,
      COALESCE(mb.liquidation_cnt, 0) AS liquidation_cnt
    FROM all_months a
    LEFT JOIN month_breakdown mb ON mb.m = a.m
  ),
  classified AS (
    SELECT
      m,
      total_cnt,
      shipment_cnt,
      refund_cnt,
      service_fee_cnt,
      adjustment_cnt,
      removal_cnt,
      liquidation_cnt,
      CASE
        WHEN total_cnt = 0 THEN 'missing'
        -- A "complete" month has shipments AND service_fees (Amazon posts service fees
        -- monthly — if a synced month has shipments but zero service_fees, the sync was
        -- partial and the month is flagged as incomplete so the user knows to re-sync).
        WHEN shipment_cnt > 0 AND service_fee_cnt = 0 THEN 'partial'
        ELSE 'cached'
      END AS status,
      CASE
        WHEN total_cnt = 0 THEN ARRAY[]::text[]
        ELSE ARRAY_REMOVE(ARRAY[
          CASE WHEN shipment_cnt = 0    THEN 'shipment'    END,
          CASE WHEN service_fee_cnt = 0 THEN 'service_fee' END
        ], NULL)
      END AS missing_types
    FROM merged
  ),
  last_sync AS (
    SELECT MAX(event_date) AS last_synced
    FROM public.financial_events_cache
    WHERE user_id = auth.uid()
      AND event_date >= make_date(p_year, 1, 1)
      AND event_date <  make_date(p_year + 1, 1, 1)
  )
  SELECT jsonb_build_object(
    'cached',  (SELECT COUNT(*) FROM classified WHERE status = 'cached'),
    'partial', (SELECT COUNT(*) FROM classified WHERE status = 'partial'),
    'missing', (SELECT COUNT(*) FROM classified WHERE status = 'missing'),
    'lastSynced', (SELECT last_synced FROM last_sync),
    'months', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'month', m - 1,
          'count', total_cnt,
          'status', status,
          'missing_types', missing_types,
          'breakdown', jsonb_build_object(
            'shipment',    shipment_cnt,
            'refund',      refund_cnt,
            'service_fee', service_fee_cnt,
            'adjustment',  adjustment_cnt,
            'removal',     removal_cnt,
            'liquidation', liquidation_cnt
          )
        ) ORDER BY m
      ) FROM classified
    )
  );
$function$;