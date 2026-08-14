-- repricer_rule_perf_raise_safety (added this session) filters
-- repricer_ai_decisions by user_id + created_at >= since and joins to
-- repricer_rules -- the table has separate single-column indexes on
-- user_id+asin, created_at, and rule_id, but no composite covering this
-- exact filter, so the query fell back to a full-ish scan and hit
-- statement_timeout in production (same missing-index class of issue as
-- 20260731160000's rule_id fix). CONCURRENTLY to avoid locking writes on a
-- table every ai-evaluate cycle inserts into.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repricer_ai_decisions_user_created
  ON public.repricer_ai_decisions (user_id, created_at DESC);
