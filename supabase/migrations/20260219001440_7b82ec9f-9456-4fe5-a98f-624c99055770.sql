ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS is_manual_priority boolean NOT NULL DEFAULT false;