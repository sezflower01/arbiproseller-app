-- Re-enable all repricer assignments that have actual stock but were wrongly disabled
UPDATE repricer_assignments ra
SET is_enabled = true
FROM inventory i
WHERE i.user_id = ra.user_id
  AND i.asin = ra.asin
  AND ra.user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND ra.marketplace = 'US'
  AND ra.status = 'active'
  AND ra.is_enabled = false
  AND (COALESCE(i.available, 0) + COALESCE(i.reserved, 0) + COALESCE(i.inbound, 0)) > 0;