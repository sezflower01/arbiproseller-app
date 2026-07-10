-- One-time fix: re-enable assignments that were incorrectly disabled
-- (they have reserved stock but available=0)
UPDATE public.repricer_assignments 
SET is_enabled = true 
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9' 
  AND asin IN ('B079STG3DR', 'B0G4BQ42W3') 
  AND marketplace = 'US' 
  AND is_enabled = false;