-- Throwaway diagnostic, continuation of 20260814063000's probe.
CREATE OR REPLACE FUNCTION public.debug_probe_group_by_asin_filters(p_user_id uuid, p_since timestamptz, p_rule_id uuid)
RETURNS TABLE(asin text, cnt bigint, raises bigint, blocks bigint, rejects bigint, first_seen timestamptz, last_seen timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.asin, COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE d.mode = 'SMART_RAISE')::bigint,
    COUNT(*) FILTER (WHERE d.raise_blocked_cooldown)::bigint,
    COUNT(*) FILTER (WHERE d.raise_rejected_floor_support)::bigint,
    MIN(d.created_at), MAX(d.created_at)
  FROM repricer_ai_decisions d
  WHERE d.user_id = p_user_id AND d.rule_id = p_rule_id AND d.created_at >= p_since
  GROUP BY 1
$$;
GRANT EXECUTE ON FUNCTION public.debug_probe_group_by_asin_filters(uuid, timestamptz, uuid) TO service_role;
