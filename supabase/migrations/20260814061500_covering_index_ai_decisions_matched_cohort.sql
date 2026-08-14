-- repricer_asin_profile_days groups by rule_id (this account has 13 rules
-- across Momentum Builder/Smart Match/Momentum Smart, not 1-3) + created_at
-- + asin/marketplace/day, plus FILTERed counts and an AVG -- confirmed via
-- direct RPC timing that idx_repricer_ai_decisions_rule_created alone still
-- forces a heap fetch per matching row for every non-indexed column this
-- query touches, and still hits statement_timeout at that volume. A
-- covering index (rule_id, created_at) INCLUDE (...) lets Postgres satisfy
-- the whole query from the index without heap fetches.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repricer_ai_decisions_matched_cohort
  ON public.repricer_ai_decisions (rule_id, created_at)
  INCLUDE (asin, marketplace, mode, raise_blocked_cooldown, raise_rejected_floor_support, offers_count);
