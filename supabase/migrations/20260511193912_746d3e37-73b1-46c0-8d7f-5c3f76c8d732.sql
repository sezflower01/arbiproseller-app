-- Extend created_listings for Stage 6 dry-run results
ALTER TABLE public.created_listings
  ADD COLUMN IF NOT EXISTS inbound_dry_run_status text NOT NULL DEFAULT 'NOT_RUN',
  ADD COLUMN IF NOT EXISTS inbound_dry_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS inbound_dry_run_plan_id text,
  ADD COLUMN IF NOT EXISTS inbound_dry_run_error text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'created_listings_validation_status_chk'
  ) THEN
    ALTER TABLE public.created_listings DROP CONSTRAINT created_listings_validation_status_chk;
  END IF;
  ALTER TABLE public.created_listings
    ADD CONSTRAINT created_listings_validation_status_chk
    CHECK (validation_status IN ('PENDING_VALIDATION','ACTIVE','FAILED_VALIDATION','SHIPMENT_BLOCKED','ARCHIVED_FAILED'));
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'created_listings_inbound_dry_run_status_chk'
  ) THEN
    ALTER TABLE public.created_listings DROP CONSTRAINT created_listings_inbound_dry_run_status_chk;
  END IF;
  ALTER TABLE public.created_listings
    ADD CONSTRAINT created_listings_inbound_dry_run_status_chk
    CHECK (inbound_dry_run_status IN ('NOT_RUN','RUNNING','PASSED','FAILED'));
END $$;

CREATE INDEX IF NOT EXISTS idx_created_listings_dry_run_status
  ON public.created_listings(user_id, inbound_dry_run_status);

-- Alert table for cancel-failures (real Amazon plan left open; manual intervention)
CREATE TABLE IF NOT EXISTS public.inbound_dry_run_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  listing_id uuid REFERENCES public.created_listings(id) ON DELETE SET NULL,
  asin text,
  sku text,
  marketplace text,
  inbound_plan_id text NOT NULL,
  alert_type text NOT NULL,
  cancel_error text,
  raw jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolved_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_dry_run_alerts_user_unresolved
  ON public.inbound_dry_run_alerts(user_id, resolved, created_at DESC);

ALTER TABLE public.inbound_dry_run_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own dry-run alerts" ON public.inbound_dry_run_alerts;
CREATE POLICY "Users view own dry-run alerts"
  ON public.inbound_dry_run_alerts
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policies — service role only.