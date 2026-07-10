-- Set all inventory items with zero stock to INACTIVE (matching BQool logic)
UPDATE inventory 
SET listing_status = 'INACTIVE'
WHERE (listing_status = 'unknown' OR listing_status IS NULL)
  AND COALESCE(available, 0) = 0 
  AND COALESCE(reserved, 0) = 0 
  AND COALESCE(inbound, 0) = 0;