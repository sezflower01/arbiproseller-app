-- Throwaway diagnostic: does rule_id = ANY(array) vs rule_id = scalar
-- explain the gap between the fast probes and the timing-out real RPC?
CREATE OR REPLACE FUNCTION public.debug_probe_array_filter(p_user_id uuid, p_since timestamptz, p_rule_ids uuid[])
RETURNS TABLE(asin text, cnt bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.asin, COUNT(*)::bigint
  FROM repricer_ai_decisions d
  WHERE d.user_id = p_user_id AND d.rule_id = ANY(p_rule_ids) AND d.created_at >= p_since
  GROUP BY 1
$$;
GRANT EXECUTE ON FUNCTION public.debug_probe_array_filter(uuid, timestamptz, uuid[]) TO service_role;
