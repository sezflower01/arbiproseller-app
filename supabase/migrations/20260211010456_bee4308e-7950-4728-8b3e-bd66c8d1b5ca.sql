-- Add fulfillment_type column to repricer_assignments
ALTER TABLE public.repricer_assignments
ADD COLUMN fulfillment_type text DEFAULT 'FBA';

-- Add check constraint
ALTER TABLE public.repricer_assignments
ADD CONSTRAINT repricer_assignments_fulfillment_type_check
CHECK (fulfillment_type IN ('FBA', 'FBM'));

-- Set all existing assignments to FBA (safe default)
UPDATE public.repricer_assignments
SET fulfillment_type = 'FBA'
WHERE fulfillment_type IS NULL;

-- Make it NOT NULL after backfill
ALTER TABLE public.repricer_assignments
ALTER COLUMN fulfillment_type SET NOT NULL;

-- Also add undercut_amount_fbm to repricer_rules for FBM-specific undercut
ALTER TABLE public.repricer_rules
ADD COLUMN undercut_amount_fbm numeric DEFAULT 0.10;