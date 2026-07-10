
-- ============================================================
-- REPRICER HARDENING: Phase 1 — Schema additions
-- Covers: Locking, Idempotency, Circuit Breaker, Anomaly Detection, DB Pressure
-- ============================================================

-- 1. Per-ASIN locking table (short-lived locks to prevent concurrent processing)
CREATE TABLE IF NOT EXISTS public.repricer_asin_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin text NOT NULL,
  sku text,
  marketplace text NOT NULL DEFAULT 'US',
  lock_owner text NOT NULL,  -- 'scheduler', 'priority_cron', 'manual', 'auto_turbo'
  locked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '3 minutes'),
  UNIQUE(user_id, asin, marketplace)
);

ALTER TABLE public.repricer_asin_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages locks" ON public.repricer_asin_locks
  FOR ALL USING (true) WITH CHECK (true);

-- Index for cleanup of expired locks
CREATE INDEX idx_repricer_asin_locks_expires ON public.repricer_asin_locks(expires_at);

-- 2. Idempotency table (prevent duplicate submissions)
CREATE TABLE IF NOT EXISTS public.repricer_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,  -- hash of user_id + asin + marketplace + target_price + source_cycle
  asin text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  target_price numeric,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  UNIQUE(user_id, idempotency_key)
);

ALTER TABLE public.repricer_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages idempotency" ON public.repricer_idempotency
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_repricer_idempotency_expires ON public.repricer_idempotency(expires_at);

-- 3. Circuit breaker / safe mode columns on repricer_settings
ALTER TABLE public.repricer_settings 
  ADD COLUMN IF NOT EXISTS safe_mode_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS safe_mode_reason text,
  ADD COLUMN IF NOT EXISTS safe_mode_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS safe_mode_auto_resume_at timestamptz,
  ADD COLUMN IF NOT EXISTS circuit_breaker_error_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS circuit_breaker_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS circuit_breaker_last_trigger text,
  ADD COLUMN IF NOT EXISTS writes_this_cycle integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS writes_cycle_start timestamptz;

-- 4. Per-ASIN anomaly tracking columns on repricer_assignments
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS anomaly_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anomaly_flags jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS anomaly_last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS recent_prices jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS oscillation_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bb_loss_after_raise_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clamp_count_today integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clamp_count_reset_at date;

-- 5. Post-apply reconciliation columns on repricer_price_actions
ALTER TABLE public.repricer_price_actions
  ADD COLUMN IF NOT EXISTS intended_price numeric,
  ADD COLUMN IF NOT EXISTS submitted_price numeric,
  ADD COLUMN IF NOT EXISTS amazon_accepted_price numeric,
  ADD COLUMN IF NOT EXISTS verified_live_price numeric,
  ADD COLUMN IF NOT EXISTS reconciliation_status text,  -- 'pending', 'matched', 'mismatch', 'unverified'
  ADD COLUMN IF NOT EXISTS reconciliation_reason text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Index for reconciliation queries
CREATE INDEX IF NOT EXISTS idx_repricer_price_actions_reconciliation 
  ON public.repricer_price_actions(reconciliation_status, created_at DESC)
  WHERE reconciliation_status IS NOT NULL;

-- Index for anomaly queries
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_anomaly 
  ON public.repricer_assignments(anomaly_score DESC)
  WHERE anomaly_score > 0;
