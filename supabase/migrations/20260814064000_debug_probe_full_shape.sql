-- Throwaway diagnostic, continuation of the 063000/063500 probes --
-- isolating whether GROUP BY marketplace + before_cutover (vs just asin)
-- is what pushes repricer_asin_profile_days into statement_timeout.
CREATE OR REPLACE FUNCTION public.debug_probe_full_shape(p_user_id uuid, p_since timestamptz, p_rule_id uuid, p_v2_cutover timestamptz)
RETURNS TABLE(asin text, marketplace text, before_cutover boolean, cnt bigint, first_seen timestamptz, last_seen timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.asin, d.marketplace, (d.created_at < p_v2_cutover), COUNT(*)::bigint,
    MIN(d.created_at), MAX(d.created_at)
  FROM repricer_ai_decisions d
  WHERE d.user_id = p_user_id AND d.rule_id = p_rule_id AND d.created_at >= p_since
  GROUP BY 1, 2, 3
$$;
GRANT EXECUTE ON FUNCTION public.debug_probe_full_shape(uuid, timestamptz, uuid, timestamptz) TO service_role;
