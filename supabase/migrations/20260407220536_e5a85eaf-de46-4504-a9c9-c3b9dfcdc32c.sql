CREATE OR REPLACE FUNCTION public.get_managed_listings_counts(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'total', COALESCE(SUM(cnt), 0),
    'per_marketplace', COALESCE(
      jsonb_object_agg(marketplace, cnt),
      '{}'::jsonb
    )
  )
  FROM (
    SELECT a.marketplace, COUNT(*) AS cnt
    FROM repricer_assignments a
    INNER JOIN inventory i ON i.asin = a.asin AND i.user_id = a.user_id
    WHERE a.user_id = p_user_id
      AND a.is_enabled = true
      AND (i.available > 0 OR i.reserved > 0)
    GROUP BY a.marketplace
  ) sub;
$$;