-- Fix MISMATCH/STRANDED items that have zero stock AND disabled assignments
-- Set available=1 safety floor and re-enable their repricer assignments

-- Step 1: Set available=1 for MISMATCH/STRANDED items with all-zero stock
UPDATE public.inventory
SET available = 1
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND listing_status IN ('MISMATCH', 'STRANDED')
  AND COALESCE(available, 0) = 0
  AND COALESCE(reserved, 0) = 0
  AND COALESCE(inbound, 0) = 0;

-- Step 2: Re-enable disabled repricer assignments for these MISMATCH/STRANDED ASINs
UPDATE public.repricer_assignments ra
SET is_enabled = true
FROM public.inventory i
WHERE ra.user_id = i.user_id
  AND ra.asin = i.asin
  AND ra.user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND i.listing_status IN ('MISMATCH', 'STRANDED')
  AND ra.is_enabled = false;