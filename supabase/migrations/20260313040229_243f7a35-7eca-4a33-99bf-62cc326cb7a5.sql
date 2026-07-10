ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS consecutive_zero_offers integer NOT NULL DEFAULT 0;