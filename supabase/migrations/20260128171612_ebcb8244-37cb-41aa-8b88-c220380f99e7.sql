-- Add last_buybox_price column to repricer_assignments for SP-API tracking
ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS last_buybox_price numeric;

-- Add comment
COMMENT ON COLUMN public.repricer_assignments.last_buybox_price IS 'Last Buy Box price from SP-API check';