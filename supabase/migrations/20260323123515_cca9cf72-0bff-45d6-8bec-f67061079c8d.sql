-- Add manual_min_price to preserve the user's original manual floor
-- This field is set when auto_lower_min_price is first enabled (snapshot of min_price_override)
-- and is never modified by the auto-floor system
ALTER TABLE public.repricer_assignments 
  ADD COLUMN IF NOT EXISTS manual_min_price numeric DEFAULT NULL;

-- Backfill: for any assignment with auto_lower_min_price already enabled,
-- snapshot current min_price_override as the manual baseline
UPDATE public.repricer_assignments
SET manual_min_price = min_price_override
WHERE auto_lower_min_price = true
  AND manual_min_price IS NULL
  AND min_price_override IS NOT NULL;