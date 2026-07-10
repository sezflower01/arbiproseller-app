-- Fix legacy assignments that have is_enabled = false (from before forced automation was implemented)
UPDATE public.repricer_assignments 
SET is_enabled = true, auto_apply_enabled = true 
WHERE is_enabled = false OR auto_apply_enabled = false;