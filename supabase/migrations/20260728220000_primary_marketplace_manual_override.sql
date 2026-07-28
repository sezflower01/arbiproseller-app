-- Lets an admin manually pin their own primary_marketplace/home_currency
-- (e.g. to preview the dynamic currency system as a CA/MX/BR seller using
-- their real data) without the weekly repricer-detect-primary-marketplace
-- cron silently reverting it back based on actual sales volume.
ALTER TABLE public.repricer_settings
  ADD COLUMN IF NOT EXISTS primary_marketplace_manual_override boolean NOT NULL DEFAULT false;
