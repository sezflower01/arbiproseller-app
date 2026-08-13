-- Lets a user hold specific (asin, marketplace) assignments out of the
-- automated "listing existence" sweep/scoped-all check (the one that can
-- flip is_enabled=false on a suppressed/not-buyable read), for cases they
-- want to review manually before any automated action touches them.
-- Does NOT affect the informational pricing-suppression-core.ts detection
-- path -- that only sets a label, never disables anything.
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS sellability_review_hold boolean NOT NULL DEFAULT false;
