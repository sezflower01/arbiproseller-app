-- Three assignments were manually starred weeks ago (is_priority=true,
-- is_manual_priority=true) and later became disabled/zero-stock/INACTIVE,
-- but nothing ever cleared their priority flags. They're invisible in the
-- normal Assignments view and in the Settings Priority Queue panel (both
-- filter is_enabled=true), yet were still being counted by
-- repricer-auto-turbo's manualStars and AssignmentsTable's priorityCount
-- (neither filtered is_enabled) -- silently consuming 3 of a 10-slot
-- budget the user could not see or free up. Confirmed live via debug
-- functions: all three are is_enabled=false with inventory.available=0
-- and listing_status='INACTIVE'.
--
-- Scoped narrowly to is_enabled=false rows (not all disabled assignments
-- generally) so this only clears genuinely orphaned/inactive stars.
UPDATE public.repricer_assignments
SET is_priority = false,
    is_manual_priority = false
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND asin IN ('B00S8GDZJQ', 'B0169INGCK', 'B0FK2YGWR2')
  AND is_enabled = false
  AND is_priority = true;
