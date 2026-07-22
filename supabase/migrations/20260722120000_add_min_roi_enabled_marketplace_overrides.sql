-- Per-marketplace "Respect minimum ROI" toggle. Previously a single global
-- min_roi_enabled boolean applied to every marketplace at once. This column
-- lets each marketplace be turned on/off independently; marketplaces absent
-- from the map fall back to the legacy min_roi_enabled boolean (existing
-- rules keep their current behavior until edited in the new per-marketplace UI).
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS min_roi_enabled_marketplace_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
