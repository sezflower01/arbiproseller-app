-- Distinct detection path for "listing is DISCOVERABLE but not BUYABLE/ACTIVE"
-- (e.g. Amazon's "Fix Price Alert" deactivation) -- separate from the existing
-- is_pricing_suppression columns, which are specifically for the issues[]
-- INVALID_PRICE+ERROR+LISTING_SUPPRESSED signal. The two can occur
-- independently and mean different things to a seller, so they get their
-- own columns rather than being conflated into the same fields.
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS is_listing_inactive_not_buyable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS listing_inactive_statuses text[],
  ADD COLUMN IF NOT EXISTS listing_inactive_detected_at timestamptz,
  ADD COLUMN IF NOT EXISTS listing_inactive_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS listing_inactive_last_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_listing_inactive
  ON public.repricer_assignments (user_id, marketplace)
  WHERE is_listing_inactive_not_buyable = true;
