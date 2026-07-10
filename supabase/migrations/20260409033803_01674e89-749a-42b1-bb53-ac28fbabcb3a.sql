
-- Add Min ROI protection toggle and marketplace overrides
ALTER TABLE public.repricer_rules 
  ADD COLUMN IF NOT EXISTS min_roi_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS min_roi_marketplace_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Add comment for clarity
COMMENT ON COLUMN public.repricer_rules.min_roi_enabled IS 'When true, enforce a minimum ROI-based price floor during repricing';
COMMENT ON COLUMN public.repricer_rules.min_roi_marketplace_overrides IS 'Per-marketplace ROI % overrides, e.g. {"US": 30, "CA": 50, "MX": 70, "BR": 70}. Falls back to min_roi_percent if marketplace not specified.';
