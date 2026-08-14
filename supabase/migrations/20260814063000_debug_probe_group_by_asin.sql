-- Throwaway diagnostic function, not part of the product -- isolating
-- whether GROUP BY asin specifically (vs GROUP BY day) is the cost driver
-- behind repricer_asin_profile_days' statement_timeout. Safe to drop later.
CREATE OR REPLACE FUNCTION public.debug_probe_group_by_asin(p_user_id uuid, p_since timestamptz, p_rule_id uuid)
RETURNS TABLE(asin text, cnt bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.asin, COUNT(*)::bigint
  FROM repricer_ai_decisions d
  WHERE d.user_id = p_user_id AND d.rule_id = p_rule_id AND d.created_at >= p_since
  GROUP BY 1
$$;
GRANT EXECUTE ON FUNCTION public.debug_probe_group_by_asin(uuid, timestamptz, uuid) TO service_role;
