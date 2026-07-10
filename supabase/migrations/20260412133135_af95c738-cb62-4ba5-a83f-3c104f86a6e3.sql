ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS bounds_synced_at TIMESTAMPTZ DEFAULT NULL;