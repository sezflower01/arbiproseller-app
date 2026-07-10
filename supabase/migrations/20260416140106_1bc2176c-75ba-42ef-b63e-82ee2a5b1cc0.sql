
-- Table to store daily parity check results
CREATE TABLE public.sync_parity_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  check_date DATE NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  so_count INT NOT NULL DEFAULT 0,
  fec_count INT NOT NULL DEFAULT 0,
  gap_type TEXT, -- 'so_missing', 'fec_missing', 'both_low', 'marketplace_gap', null=healthy
  repair_status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'queued', 'repaired', 'skipped'
  repair_triggered_at TIMESTAMPTZ,
  repaired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, check_date, marketplace)
);

ALTER TABLE public.sync_parity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own parity logs"
  ON public.sync_parity_log FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all parity logs"
  ON public.sync_parity_log FOR SELECT
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Index for fast lookups
CREATE INDEX idx_sync_parity_log_user_date ON public.sync_parity_log(user_id, check_date);
CREATE INDEX idx_sync_parity_log_gap ON public.sync_parity_log(gap_type) WHERE gap_type IS NOT NULL;

-- Function to run parity check for a single user across last N days
CREATE OR REPLACE FUNCTION public.check_sync_parity(p_user_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE(check_date DATE, marketplace TEXT, so_count BIGINT, fec_count BIGINT, gap_type TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH date_range AS (
    SELECT generate_series(
      (CURRENT_DATE - (p_days || ' days')::interval)::date,
      CURRENT_DATE - 1,
      '1 day'::interval
    )::date AS d
  ),
  so_counts AS (
    SELECT order_date::date AS d, COALESCE(marketplace, 'US') AS mp, COUNT(*) AS cnt
    FROM sales_orders
    WHERE user_id = p_user_id
      AND order_date >= CURRENT_DATE - (p_days || ' days')::interval
      AND order_date < CURRENT_DATE
      AND COALESCE(order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (is_cancelled IS NULL OR is_cancelled = false)
    GROUP BY 1, 2
  ),
  fec_counts AS (
    SELECT event_date::date AS d, COALESCE(marketplace, 'US') AS mp, COUNT(*) AS cnt
    FROM financial_events_cache
    WHERE user_id = p_user_id
      AND event_date >= CURRENT_DATE - (p_days || ' days')::interval
      AND event_date < CURRENT_DATE
      AND event_type = 'shipment'
    GROUP BY 1, 2
  ),
  all_marketplaces AS (
    SELECT DISTINCT mp FROM (
      SELECT mp FROM so_counts UNION SELECT mp FROM fec_counts
    ) u
  ),
  combined AS (
    SELECT
      dr.d AS check_date,
      am.mp AS marketplace,
      COALESCE(so.cnt, 0) AS so_count,
      COALESCE(fec.cnt, 0) AS fec_count,
      CASE
        WHEN COALESCE(so.cnt, 0) = 0 AND COALESCE(fec.cnt, 0) > 5 THEN 'so_missing'
        WHEN COALESCE(fec.cnt, 0) = 0 AND COALESCE(so.cnt, 0) > 5 THEN 'fec_missing'
        WHEN COALESCE(so.cnt, 0) = 0 AND COALESCE(fec.cnt, 0) = 0 THEN NULL -- no activity
        WHEN COALESCE(so.cnt, 0) > 0 AND COALESCE(fec.cnt, 0) > 0
             AND COALESCE(so.cnt, 0)::float / GREATEST(COALESCE(fec.cnt, 0), 1) < 0.3 THEN 'so_missing'
        ELSE NULL
      END AS gap_type
    FROM date_range dr
    CROSS JOIN all_marketplaces am
    LEFT JOIN so_counts so ON so.d = dr.d AND so.mp = am.mp
    LEFT JOIN fec_counts fec ON fec.d = dr.d AND fec.mp = am.mp
  )
  SELECT * FROM combined WHERE gap_type IS NOT NULL;
$$;
