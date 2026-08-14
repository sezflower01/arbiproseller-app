-- The composite (user_id, created_at) index still wasn't enough:
-- repricer_ai_decisions logs EVERY evaluation cycle (not just price
-- changes, unlike repricer_price_actions), so a 30-day window for an
-- active account is still enormous to GROUP BY. But the raise-safety
-- metrics only ever care about a small minority of rows -- raise attempts,
-- cooldown blocks, and floor-support rejections -- so filter to exactly
-- those up front, backed by a partial index scoped to the same condition.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repricer_ai_decisions_raise_safety
  ON public.repricer_ai_decisions (user_id, created_at DESC)
  WHERE mode = 'SMART_RAISE' OR raise_blocked_cooldown OR raise_rejected_floor_support;

-- CREATE OR REPLACE can't change the RETURNS TABLE column set (dropping
-- total_decisions here), so drop first.
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
    COALESCE(rr.smart_profile, 'CUSTOM') AS smart_profile,
    d.created_at::date AS decision_day,
    COUNT(*) FILTER (WHERE d.mode = 'SMART_RAISE')::bigint AS raise_attempts,
    COUNT(*) FILTER (WHERE d.raise_blocked_cooldown)::bigint AS cooldown_blocks,
    COUNT(*) FILTER (WHERE d.raise_rejected_floor_support)::bigint AS floor_rejects
  FROM repricer_ai_decisions d
  JOIN repricer_rules rr ON rr.id = d.rule_id
  WHERE d.user_id = p_user_id
    AND d.created_at >= p_since
    AND d.rule_id IS NOT NULL
    AND (d.mode = 'SMART_RAISE' OR d.raise_blocked_cooldown OR d.raise_rejected_floor_support)
  GROUP BY 1, 2
$$;

GRANT EXECUTE ON FUNCTION public.repricer_rule_perf_raise_safety(uuid, timestamptz) TO service_role;
