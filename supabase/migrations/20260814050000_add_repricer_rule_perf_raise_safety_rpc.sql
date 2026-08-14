-- Momentum Smart V2 raise-safety aggregation, same reasoning as the other
-- two repricer_rule_perf_* RPCs: repricer_ai_decisions is written on every
-- evaluation cycle (far higher volume than repricer_price_actions, which
-- only writes on Buy Box or price changes), so grouping in Postgres instead
-- of paging the table through the edge function is required, not optional.
--
-- Grouped by day (not just totals) so the edge function can split
-- MOMENTUM_SMART into V1/V2 sub-rows by comparing decision_day against the
-- hardcoded V2 cutover timestamp, the same day-level approximation already
-- used for repricer_rule_perf_sales.
CREATE OR REPLACE FUNCTION public.repricer_rule_perf_raise_safety(p_user_id uuid, p_since timestamptz)
RETURNS TABLE(
  smart_profile text,
  decision_day date,
  total_decisions bigint,
  raise_attempts bigint,
  cooldown_blocks bigint,
  floor_rejects bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(rr.smart_profile, 'CUSTOM') AS smart_profile,
    d.created_at::date AS decision_day,
    COUNT(*)::bigint AS total_decisions,
    COUNT(*) FILTER (WHERE d.mode = 'SMART_RAISE')::bigint AS raise_attempts,
    COUNT(*) FILTER (WHERE d.raise_blocked_cooldown)::bigint AS cooldown_blocks,
    COUNT(*) FILTER (WHERE d.raise_rejected_floor_support)::bigint AS floor_rejects
  FROM repricer_ai_decisions d
  JOIN repricer_rules rr ON rr.id = d.rule_id
  WHERE d.user_id = p_user_id
    AND d.created_at >= p_since
    AND d.rule_id IS NOT NULL
  GROUP BY 1, 2
$$;

REVOKE ALL ON FUNCTION public.repricer_rule_perf_raise_safety(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repricer_rule_perf_raise_safety(uuid, timestamptz) TO service_role;
