-- Root cause of the statement_timeout, confirmed by direct probing: this
-- account has 13 rule_ids across Momentum Builder / Smart Match / Momentum
-- Smart, and `rule_id = ANY(p_rule_ids)` -- even with a ONE-element array --
-- makes Postgres pick a much worse plan than `rule_id = p_rule_id`
-- (a well-known Postgres gotcha: a parameterized array-membership filter in
-- a cached/generic plan often can't use a targeted index range scan the way
-- scalar equality can). Every other candidate (GROUP BY asin, marketplace,
-- before_cutover; the 3 FILTER counts; MIN/MAX) tested fast in isolation --
-- only swapping the array filter for scalar equality fixed it (77ms vs 15s+
-- timeout on the identical query otherwise).
--
-- Fix: scalar p_rule_id instead of p_rule_ids uuid[] -- the edge function
-- now calls this once per rule_id (in parallel) instead of once for all
-- rules at once.
DROP FUNCTION IF EXISTS public.repricer_asin_profile_days(uuid, timestamptz, uuid[], timestamptz);

CREATE FUNCTION public.repricer_asin_profile_days(p_user_id uuid, p_since timestamptz, p_rule_id uuid, p_v2_cutover timestamptz)
RETURNS TABLE(
  asin text,
  marketplace text,
  rule_id uuid,
  before_cutover boolean,
  first_seen timestamptz,
  last_seen timestamptz,
  decision_count bigint,
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
    d.asin,
    d.marketplace,
    d.rule_id,
    (d.created_at < p_v2_cutover) AS before_cutover,
    MIN(d.created_at) AS first_seen,
    MAX(d.created_at) AS last_seen,
    COUNT(*)::bigint AS decision_count,
    COUNT(*) FILTER (WHERE d.mode = 'SMART_RAISE')::bigint AS raise_attempts,
    COUNT(*) FILTER (WHERE d.raise_blocked_cooldown)::bigint AS cooldown_blocks,
    COUNT(*) FILTER (WHERE d.raise_rejected_floor_support)::bigint AS floor_rejects
  FROM repricer_ai_decisions d
  WHERE d.user_id = p_user_id
    AND d.created_at >= p_since
    AND d.rule_id = p_rule_id
  GROUP BY 1, 2, 3, 4
$$;

GRANT EXECUTE ON FUNCTION public.repricer_asin_profile_days(uuid, timestamptz, uuid, timestamptz) TO service_role;

-- Clean up the throwaway diagnostic probe functions from this investigation.
DROP FUNCTION IF EXISTS public.debug_probe_group_by_asin(uuid, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.debug_probe_group_by_asin_filters(uuid, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.debug_probe_full_shape(uuid, timestamptz, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.debug_probe_array_filter(uuid, timestamptz, uuid[]);
DROP FUNCTION IF EXISTS public.debug_minimal_agg(uuid, timestamptz, uuid);
