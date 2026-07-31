-- Same fix as 20260731150000, for repricer_ai_decisions.rule_id
-- (1.7M+ rows, also missing an index, also ON DELETE SET NULL).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repricer_ai_decisions_rule_id
  ON public.repricer_ai_decisions (rule_id);
