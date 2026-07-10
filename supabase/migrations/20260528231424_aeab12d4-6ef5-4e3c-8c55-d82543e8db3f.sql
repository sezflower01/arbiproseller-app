-- Phase 3A repair: 4 ASINs hit by the over-aggressive repricer-cleanup sweep.
-- 1) Backfill inventory.cost from created_listings.cost when missing
-- 2) Clear stale "cleanup" disable audit and re-enable the assignments
--    (cleanup itself is now patched to only hard-disable truly terminal rows).

-- 1. Backfill inventory.cost from created_listings (latest non-null cost per asin)
WITH latest_cl AS (
  SELECT DISTINCT ON (user_id, asin)
    user_id, asin, cost
  FROM public.created_listings
  WHERE asin IN ('B08ML5SP3Y','B07CB1M6N7','B07BTGQHZZ','B0GXCDB8XM')
    AND cost IS NOT NULL AND cost > 0
  ORDER BY user_id, asin, created_at DESC
)
UPDATE public.inventory i
SET cost = lc.cost,
    updated_at = now()
FROM latest_cl lc
WHERE i.user_id = lc.user_id
  AND i.asin = lc.asin
  AND (i.cost IS NULL OR i.cost = 0);

-- 2. Clear stale cleanup disable audit + re-enable the 4 ASINs
UPDATE public.repricer_assignments
SET is_enabled = true,
    manual_paused = false,
    auto_suspended_reason = NULL,
    last_disabled_by = NULL,
    last_disabled_reason = NULL,
    last_disabled_at = NULL,
    last_enabled_by = 'phase3a-repair',
    last_enabled_at = now(),
    updated_at = now()
WHERE asin IN ('B08ML5SP3Y','B07CB1M6N7','B07BTGQHZZ','B0GXCDB8XM')
  AND last_disabled_by = 'cleanup';