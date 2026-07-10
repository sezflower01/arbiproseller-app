
-- Phase 1: new observability columns on repricer_assignments
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS amazon_listing_state   TEXT,
  ADD COLUMN IF NOT EXISTS last_listing_check_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inventory_confidence   TEXT,
  ADD COLUMN IF NOT EXISTS intl_qty_confidence    TEXT,
  ADD COLUMN IF NOT EXISTS auto_suspended_reason  TEXT,
  ADD COLUMN IF NOT EXISTS auto_suspended_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_suspended_by      TEXT;

-- Index for filtering suspended rows in the admin diagnostics view
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_auto_suspended
  ON public.repricer_assignments (auto_suspended_reason)
  WHERE auto_suspended_reason IS NOT NULL;

-- One-time backfill: listing state UNKNOWN until SP-API proves otherwise
UPDATE public.repricer_assignments
SET amazon_listing_state = 'UNKNOWN'
WHERE amazon_listing_state IS NULL;

-- Backfill inventory_confidence from existing inventory freshness timestamp if present.
-- We use last_summaries_at on the assignment if it exists, otherwise leave UNKNOWN.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='repricer_assignments' AND column_name='last_summaries_at'
  ) THEN
    EXECUTE $sql$
      UPDATE public.repricer_assignments
      SET inventory_confidence = CASE
        WHEN last_summaries_at IS NULL THEN 'UNKNOWN'
        WHEN last_summaries_at > now() - INTERVAL '6 hours'  THEN 'HIGH'
        WHEN last_summaries_at > now() - INTERVAL '24 hours' THEN 'MEDIUM'
        ELSE 'STALE'
      END
      WHERE inventory_confidence IS NULL
    $sql$;
  ELSE
    UPDATE public.repricer_assignments
    SET inventory_confidence = 'UNKNOWN'
    WHERE inventory_confidence IS NULL;
  END IF;
END $$;

-- Same for intl_qty_confidence, derived from intl_qty_fetched_at if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='repricer_assignments' AND column_name='intl_qty_fetched_at'
  ) THEN
    EXECUTE $sql$
      UPDATE public.repricer_assignments
      SET intl_qty_confidence = CASE
        WHEN intl_qty_fetched_at IS NULL THEN 'UNKNOWN'
        WHEN intl_qty_fetched_at > now() - INTERVAL '6 hours'  THEN 'HIGH'
        WHEN intl_qty_fetched_at > now() - INTERVAL '24 hours' THEN 'MEDIUM'
        ELSE 'STALE'
      END
      WHERE intl_qty_confidence IS NULL
    $sql$;
  ELSE
    UPDATE public.repricer_assignments
    SET intl_qty_confidence = 'UNKNOWN'
    WHERE intl_qty_confidence IS NULL;
  END IF;
END $$;

-- Tag existing audit-less disables so the UI can explain them.
UPDATE public.repricer_assignments
SET auto_suspended_reason = 'LEGACY_UNAUDITED',
    auto_suspended_at     = COALESCE(last_disabled_at, now()),
    auto_suspended_by     = 'backfill_phase1'
WHERE is_enabled = false
  AND auto_suspended_reason IS NULL
  AND (last_disabled_reason IS NULL OR last_disabled_reason = '')
  AND COALESCE(manual_paused, false) = false;

-- ===== Diagnostics table (read-only, Phase 2 will populate) =====

CREATE TABLE IF NOT EXISTS public.repricer_eligibility_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   UUID NOT NULL,
  user_id         UUID NOT NULL,
  asin            TEXT NOT NULL,
  marketplace_id  TEXT,
  is_enabled_actual BOOLEAN NOT NULL,
  derived_eligible  BOOLEAN NOT NULL,
  derived_reason    TEXT,
  factors           JSONB NOT NULL DEFAULT '{}'::jsonb,
  matched           BOOLEAN NOT NULL,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.repricer_eligibility_audit TO authenticated;
GRANT ALL    ON public.repricer_eligibility_audit TO service_role;

ALTER TABLE public.repricer_eligibility_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can read their eligibility audit"  ON public.repricer_eligibility_audit;
CREATE POLICY "Owners can read their eligibility audit"
ON public.repricer_eligibility_audit
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_elig_audit_user_asin_time
  ON public.repricer_eligibility_audit (user_id, asin, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_elig_audit_mismatch_time
  ON public.repricer_eligibility_audit (observed_at DESC)
  WHERE matched = false;
