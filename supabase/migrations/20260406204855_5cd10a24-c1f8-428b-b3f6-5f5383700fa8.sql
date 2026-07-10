
-- Mark the deleted ASIN as INACTIVE in inventory
UPDATE public.inventory 
SET listing_status = 'INACTIVE', updated_at = now()
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9' 
  AND asin = 'B08JQQR7L4';

-- Ensure the assignment is disabled
UPDATE public.repricer_assignments 
SET is_enabled = false, updated_at = now()
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9' 
  AND asin = 'B08JQQR7L4';
