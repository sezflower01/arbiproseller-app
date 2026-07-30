-- B007P1ZO94's US assignment (repricer_assignments.is_enabled=true,
-- is_priority=true, is_manual_priority=true) was starred while active, but
-- its SKU's inventory is now available=0 / listing_status='INACTIVE' -- the
-- real Amazon listing is dead. Nothing clears is_enabled when a listing
-- goes inactive, so the star flag was never cleared and kept consuming a
-- slot with no way for the user to see or remove it (same failure class as
-- 20260730040000_clear_orphaned_priority_stars.sql, but caught by
-- is_enabled=true so missed by that pass). Scoped to the specific
-- confirmed-dead row, not a blanket sweep.
UPDATE public.repricer_assignments a
SET is_priority = false,
    is_manual_priority = false
FROM public.inventory i
WHERE a.user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND a.asin = 'B007P1ZO94'
  AND a.marketplace = 'US'
  AND a.is_priority = true
  AND i.user_id = a.user_id
  AND i.sku = a.sku
  AND COALESCE(i.available, 0) = 0;
