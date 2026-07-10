-- Phase B: per-stage FBA readiness cache + immutable audit log.
-- Each (user, asin, marketplace, stage) carries its own status, reason, raw payload,
-- and checked_at so stages can be cached independently with their own TTLs.

CREATE TABLE IF NOT EXISTS public.fba_readiness_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  stage TEXT NOT NULL,             -- 'fba_eligibility' | 'hazmat' | 'prep' | 'inbound_dry_run'
  status TEXT NOT NULL,            -- 'ok' | 'warn' | 'blocked' | 'unknown'
  reason TEXT,
  raw JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, marketplace, stage)
);

CREATE INDEX IF NOT EXISTS idx_fba_readiness_cache_user_asin
  ON public.fba_readiness_cache (user_id, asin, marketplace);

ALTER TABLE public.fba_readiness_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own readiness cache"
  ON public.fba_readiness_cache FOR SELECT
  USING (auth.uid() = user_id);

-- Writes happen only via edge functions using service_role (bypasses RLS); we
-- still add an explicit deny for direct client writes.
CREATE POLICY "No direct client writes to readiness cache"
  ON public.fba_readiness_cache FOR ALL
  USING (false) WITH CHECK (false);

-- Append-only audit of every stage outcome (kept separate from cache so we can
-- look back at how a stage flipped over time without losing rows on re-check).
CREATE TABLE IF NOT EXISTS public.fba_readiness_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  raw JSONB,
  source TEXT,                      -- 'check-fba-listing-eligibility' | 'dry-run-inbound-plan' | ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fba_readiness_audit_user_asin_time
  ON public.fba_readiness_audit (user_id, asin, marketplace, created_at DESC);

ALTER TABLE public.fba_readiness_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own readiness audit"
  ON public.fba_readiness_audit FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "No direct client writes to readiness audit"
  ON public.fba_readiness_audit FOR ALL
  USING (false) WITH CHECK (false);
