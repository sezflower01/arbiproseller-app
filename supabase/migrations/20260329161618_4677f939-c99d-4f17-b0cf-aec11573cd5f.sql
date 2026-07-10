ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS intl_listing_status text DEFAULT NULL;