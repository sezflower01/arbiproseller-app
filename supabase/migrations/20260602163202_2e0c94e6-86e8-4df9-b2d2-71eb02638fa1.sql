
CREATE OR REPLACE FUNCTION public.get_monitor_assignment_stats(
  p_user_id uuid,
  p_today_start timestamptz DEFAULT date_trunc('day', now())
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Only the user themselves or an admin may read these aggregates.
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH us_with_rule AS (
    SELECT DISTINCT asin
    FROM public.repricer_assignments
    WHERE user_id = p_user_id
      AND COALESCE(marketplace, 'US') = 'US'
      AND rule_id IS NOT NULL
  ),
  us_all AS (
    SELECT DISTINCT asin
    FROM public.repricer_assignments
    WHERE user_id = p_user_id
      AND COALESCE(marketplace, 'US') = 'US'
  ),
  classified AS (
    SELECT
      a.asin,
      COALESCE(a.marketplace, 'US') AS marketplace,
      a.status,
      a.is_enabled,
      a.rule_id,
      a.last_sp_api_check_at,
      (
        a.rule_id IS NOT NULL
        OR (
          COALESCE(a.marketplace, 'US') <> 'US'
          AND a.asin IN (SELECT asin FROM us_with_rule)
        )
      ) AS has_effective_rule,
      (a.asin IN (SELECT asin FROM us_all)) AS has_us_listing
    FROM public.repricer_assignments a
    WHERE a.user_id = p_user_id
  ),
  bucketed AS (
    SELECT
      asin,
      marketplace,
      last_sp_api_check_at,
      CASE
        WHEN status IS DISTINCT FROM 'active' THEN 'inactive'
        WHEN is_enabled IS FALSE THEN 'disabled'
        WHEN NOT has_effective_rule AND marketplace <> 'US' AND NOT has_us_listing THEN 'no_us_listing'
        WHEN NOT has_effective_rule THEN 'no_rule'
        ELSE 'eligible'
      END AS bucket
    FROM classified
  ),
  per_mkt AS (
    SELECT
      marketplace,
      COUNT(*)::int                                                                    AS total,
      COUNT(*) FILTER (WHERE bucket = 'inactive')::int                                 AS inactive,
      COUNT(*) FILTER (WHERE bucket = 'disabled')::int                                 AS disabled,
      COUNT(*) FILTER (WHERE bucket = 'no_us_listing')::int                            AS no_us_listing,
      COUNT(*) FILTER (WHERE bucket = 'no_rule')::int                                  AS no_rule,
      COUNT(*) FILTER (WHERE bucket = 'eligible')::int                                 AS eligible,
      COUNT(*) FILTER (WHERE bucket <> 'inactive')::int                                AS active,
      COUNT(*) FILTER (WHERE last_sp_api_check_at >= p_today_start)::int               AS checked_today,
      COUNT(DISTINCT asin) FILTER (WHERE last_sp_api_check_at >= p_today_start)::int   AS unique_asins_checked,
      COUNT(DISTINCT asin) FILTER (WHERE bucket <> 'inactive')::int                    AS unique_active_asins,
      COUNT(DISTINCT asin) FILTER (WHERE bucket = 'eligible')::int                     AS unique_eligible_asins,
      COUNT(*) FILTER (WHERE bucket = 'eligible' AND last_sp_api_check_at >= p_today_start)::int             AS checked_eligible_today,
      COUNT(DISTINCT asin) FILTER (WHERE bucket = 'eligible' AND last_sp_api_check_at >= p_today_start)::int AS unique_eligible_asins_checked_today
    FROM bucketed
    GROUP BY marketplace
  )
  SELECT jsonb_build_object(
    'per_marketplace',
    COALESCE(jsonb_object_agg(marketplace, to_jsonb(per_mkt) - 'marketplace'), '{}'::jsonb)
  )
  INTO v_result
  FROM per_mkt;

  RETURN COALESCE(v_result, jsonb_build_object('per_marketplace', '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.get_monitor_assignment_stats(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monitor_assignment_stats(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_monitor_assignment_stats(uuid, timestamptz) TO service_role;
