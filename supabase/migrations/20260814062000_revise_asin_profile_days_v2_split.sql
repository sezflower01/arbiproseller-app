-- repricer_asin_profile_days (from 20260814060000) grouped by calendar day
-- and hit statement_timeout even scoped to ONE rule_id, backed by a
-- covering index (idx_repricer_ai_decisions_matched_cohort). Confirmed via
-- direct RPC timing: a plain COUNT(*) over the same 13-rule/30-day filter
-- succeeds fine through PostgREST, but this GROUP BY (asin, marketplace,
-- rule_id, day) with 3 FILTERed counts times out -- the per-row date cast
-- plus a high-cardinality (asin × ~30 days) hash table is real added cost
-- on top of the scan, even with the index.
--
-- Momentum Smart V1/V2 splitting is the only reason day-level precision was
-- needed at all (a single rule_id spans both sides of the cutover). Every
-- other rule doesn't need it. So: group by (asin, marketplace, rule_id,
-- before_cutover) instead -- 2 buckets per rule instead of ~30 -- and use
-- MIN/MAX(created_at) to recover each window's actual date range without a
-- bucket for every day in between. Also drops AVG(offers_count) (the
-- "competition level" cohort dimension) since reading that column per row
-- added cost for a dimension the request only asked for as one of several
-- "such as" examples, not a requirement -- cohort matching below falls back
-- to volume + price only.
DROP FUNCTION IF EXISTS public.repricer_asin_profile_days(uuid, timestamptz, uuid[]);

CREATE FUNCTION public.repricer_asin_profile_days(p_user_id uuid, p_since timestamptz, p_rule_ids uuid[], p_v2_cutover timestamptz)
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
    AND d.rule_id = ANY(p_rule_ids)
  GROUP BY 1, 2, 3, 4
$$;

GRANT EXECUTE ON FUNCTION public.repricer_asin_profile_days(uuid, timestamptz, uuid[], timestamptz) TO service_role;
