-- Split into its own file: CONCURRENTLY only succeeds as the sole statement
-- in this migration runner's execution mode (confirmed: it works as
-- statement 1 alone, but errors "cannot be executed within a pipeline" when
-- a second statement follows in the same file).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repricer_ai_decisions_rule_created
  ON public.repricer_ai_decisions (rule_id, created_at DESC);
