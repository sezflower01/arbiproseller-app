-- Add ROI Range caching columns to repricer_assignments
ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS roi_at_min_percent numeric,
ADD COLUMN IF NOT EXISTS roi_at_max_percent numeric,
ADD COLUMN IF NOT EXISTS roi_range_updated_at timestamp with time zone;