
-- Add international quantity columns to repricer_assignments
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS intl_available integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS intl_reserved integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS intl_inbound integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS intl_qty_fetched_at timestamp with time zone DEFAULT NULL;
