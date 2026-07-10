-- Add min_roi_override column to repricer_assignments for per-ASIN ROI threshold customization
ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS min_roi_override numeric NULL;

-- Add comment explaining the column's purpose
COMMENT ON COLUMN public.repricer_assignments.min_roi_override IS 'Per-ASIN override for minimum ROI percentage. If NULL, uses the rule min_roi_percent value.';