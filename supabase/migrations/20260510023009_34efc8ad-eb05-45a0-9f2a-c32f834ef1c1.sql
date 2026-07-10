-- Backfill: clear stale INVALID_FNSKU blocks where a valid FNSKU now exists in fnsku_map.
-- Mirrors the new self-heal path in check-fba-listing-eligibility.

-- 1) inventory
UPDATE public.inventory inv
SET fba_blocked = false,
    fba_block_reason = NULL
WHERE inv.fba_blocked = true
  AND inv.fba_block_reason ILIKE '%INVALID_FNSKU%'
  AND EXISTS (
    SELECT 1 FROM public.fnsku_map fm
    WHERE fm.asin = inv.asin
      AND fm.fnsku ~ '^X[A-Z0-9]{9}$'
  );

-- 2) created_listings
UPDATE public.created_listings cl
SET fba_blocked = false,
    fba_block_reason = NULL
WHERE cl.fba_blocked = true
  AND cl.fba_block_reason ILIKE '%INVALID_FNSKU%'
  AND EXISTS (
    SELECT 1 FROM public.fnsku_map fm
    WHERE fm.asin = cl.asin
      AND fm.fnsku ~ '^X[A-Z0-9]{9}$'
  );

-- 3) Invalidate the eligibility cache for any INVALID_FNSKU entries so the next
-- UI check re-runs the new self-heal path instead of returning stale data.
DELETE FROM public.fba_eligibility_cache
WHERE fba_block_reason ILIKE '%INVALID_FNSKU%';