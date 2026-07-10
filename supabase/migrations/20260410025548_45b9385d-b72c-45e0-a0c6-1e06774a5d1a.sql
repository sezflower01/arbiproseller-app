UPDATE public.repricer_assignments
SET is_enabled = false
WHERE asin IN ('B07CHZ876G', 'B0DK9PHZ6S')
AND marketplace = 'US'
AND is_enabled = true;