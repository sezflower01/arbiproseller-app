ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS is_restricted boolean NOT NULL DEFAULT false;