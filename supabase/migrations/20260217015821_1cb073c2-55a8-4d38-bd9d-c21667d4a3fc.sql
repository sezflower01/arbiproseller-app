-- This is a data update, using service role via function
-- Set min_roi_override for specific assignment
UPDATE public.repricer_assignments 
SET min_roi_override = 20 
WHERE id = 'cb0ba019-876b-4758-a797-3849becd681e';