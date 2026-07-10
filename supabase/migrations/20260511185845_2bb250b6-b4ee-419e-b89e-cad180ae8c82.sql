
-- Phase C1: Transactional listing validation lifecycle
-- Default ACTIVE for all existing rows = zero behavior change until C2 starts marking new rows PENDING.

ALTER TABLE public.created_listings
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS validation_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS validation_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS validation_failure_code text,
  ADD COLUMN IF NOT EXISTS validation_failure_reason text,
  ADD COLUMN IF NOT EXISTS validation_attempts integer NOT NULL DEFAULT 0;

-- Constrain valid states
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'created_listings_validation_status_chk'
  ) THEN
    ALTER TABLE public.created_listings
      ADD CONSTRAINT created_listings_validation_status_chk
      CHECK (validation_status IN ('PENDING_VALIDATION','ACTIVE','FAILED_VALIDATION','ARCHIVED_FAILED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_created_listings_validation_status
  ON public.created_listings(user_id, validation_status);

CREATE INDEX IF NOT EXISTS idx_created_listings_validation_pending
  ON public.created_listings(validation_status, validation_started_at)
  WHERE validation_status = 'PENDING_VALIDATION';

-- Helper: single source of truth for "is this listing visible to downstream systems?"
CREATE OR REPLACE FUNCTION public.is_listing_validated(_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT _status = 'ACTIVE';
$$;

-- Audit table: immutable history of every stage transition
CREATE TABLE IF NOT EXISTS public.listing_validation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  listing_id uuid,
  asin text,
  sku text,
  marketplace text,
  stage text NOT NULL,
  status text NOT NULL,
  reason text,
  raw jsonb,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_validation_audit_user_listing
  ON public.listing_validation_audit(user_id, listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listing_validation_audit_asin
  ON public.listing_validation_audit(user_id, asin, marketplace, created_at DESC);

ALTER TABLE public.listing_validation_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own validation audit" ON public.listing_validation_audit;
CREATE POLICY "Users view own validation audit"
  ON public.listing_validation_audit
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for clients — service role only (edge functions).
