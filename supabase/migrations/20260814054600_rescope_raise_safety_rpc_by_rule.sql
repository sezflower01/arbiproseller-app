-- Previous attempt (20260814053000) filtered by mode/boolean flags across
-- EVERY preset -- but enable_smart_raise (and therefore mode='SMART_RAISE')
-- is true for Momentum Builder, Profit Extractor, and Velocity Dominator
-- too, not just Momentum Smart, so that scan was still effectively
-- account-wide and kept hitting statement_timeout even with the partial
-- index (confirmed via direct RPC timing: 15s+ and still cancelled).
--
-- cooldown_blocks / floor_rejects can ONLY ever be true for a rule with
-- post_raise_cooldown_hours / min_floor_support_ratio set, which today only
-- MOMENTUM_SMART's preset does -- and raise_attempts is only meaningful for
-- this dashboard in the context of that same preset's raise-safety
-- comparison (the existing repricer_rule_perf_raises RPC already covers
-- cross-preset submitted-raise counts). So scope directly to this user's
-- MOMENTUM_SMART rule_id(s) instead of a mode/boolean filter -- a rule_id
-- lookup is far more selective than scanning by decision content, and reuses
-- the existing idx_repricer_ai_decisions_rule_id index.
-- (idx_repricer_ai_decisions_raise_safety from the previous attempt is left
-- in place rather than dropped -- DROP INDEX CONCURRENTLY can't run in this
-- migration runner's pipelined execution mode, and the index is small/scoped
-- enough to be harmless dead weight now that this RPC no longer uses it.
-- idx_repricer_ai_decisions_rule_created was split into its own migration,
-- 20260814054500, for the same CONCURRENTLY-pipelining reason.)
DROP FUNCTION IF EXISTS public.repricer_rule_perf_raise_safety(uuid, timestamptz);

CREATE FUNCTION public.repricer_rule_perf_raise_safety(p_user_id uuid, p_since timestamptz)
RETURNS TABLE(
  smart_profile text,
  decision_day date,
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
    'MOMENTUM_SMART' AS smart_profile,
    d.created_at::date AS decision_day,
    COUNT(*) FILTER (WHERE d.mode = 'SMART_RAISE')::bigint AS raise_attempts,
    COUNT(*) FILTER (WHERE d.raise_blocked_cooldown)::bigint AS cooldown_blocks,
    COUNT(*) FILTER (WHERE d.raise_rejected_floor_support)::bigint AS floor_rejects
  FROM repricer_ai_decisions d
  WHERE d.created_at >= p_since
    AND d.rule_id IN (
      SELECT id FROM repricer_rules WHERE user_id = p_user_id AND smart_profile = 'MOMENTUM_SMART'
    )
  GROUP BY 1, 2
$$;

GRANT EXECUTE ON FUNCTION public.repricer_rule_perf_raise_safety(uuid, timestamptz) TO service_role;
