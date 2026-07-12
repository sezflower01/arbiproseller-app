
CREATE OR REPLACE FUNCTION public.get_year_cache_status(p_year integer)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH month_counts AS (
    SELECT EXTRACT(MONTH FROM event_date)::int AS m, COUNT(*)::int AS cnt
    FROM public.financial_events_cache
    WHERE user_id = auth.uid()
      AND event_date >= make_date(p_year, 1, 1)
      AND event_date < make_date(p_year + 1, 1, 1)
    GROUP BY 1
  ),
  all_months AS (SELECT generate_series(1, 12) AS m),
  merged AS (
    SELECT a.m, COALESCE(mc.cnt, 0) AS cnt
    FROM all_months a LEFT JOIN month_counts mc ON mc.m = a.m
  ),
  last_sync AS (
    SELECT MAX(event_date) AS last_synced
    FROM public.financial_events_cache
    WHERE user_id = auth.uid()
      AND event_date >= make_date(p_year, 1, 1)
      AND event_date < make_date(p_year + 1, 1, 1)
  )
  SELECT jsonb_build_object(
    'cached', (SELECT COUNT(*) FROM merged WHERE cnt > 0),
    'missing', (SELECT COUNT(*) FROM merged WHERE cnt = 0),
    'lastSynced', (SELECT last_synced FROM last_sync),
    'months', (SELECT jsonb_agg(jsonb_build_object('month', m - 1, 'count', cnt, 'status', CASE WHEN cnt > 0 THEN 'cached' ELSE 'missing' END) ORDER BY m) FROM merged)
  );
$$;
