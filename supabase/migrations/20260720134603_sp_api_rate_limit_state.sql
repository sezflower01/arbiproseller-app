-- Cross-invocation SP-API rate-limit gate. Amazon's getItemOffersBatch is
-- 0.1 req/s (burst 1) per seller account, shared account-wide across all
-- marketplaces on the NA endpoint. Multiple concurrent callers (the two
-- staggered unified-dispatch cron shards, plus 4 marketplaces) currently
-- have no shared awareness of each other's calls, so the real cadence can
-- run ~20x faster than Amazon allows. This table + the claim pattern below
-- (mirrors keepa_daily_usage's acquireKeepaGlobalSlot) lets any caller
-- atomically claim the next allowed call slot per (user_id, operation).
CREATE TABLE IF NOT EXISTS public.sp_api_rate_limit_state (
  user_id uuid NOT NULL,
  operation text NOT NULL,
  last_called_at timestamptz,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, operation)
);

ALTER TABLE public.sp_api_rate_limit_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage sp_api_rate_limit_state"
  ON public.sp_api_rate_limit_state FOR ALL TO service_role USING (true) WITH CHECK (true);
