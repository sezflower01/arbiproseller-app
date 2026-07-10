-- Add requires_expiration column to inventory table
-- This tracks whether a product requires an expiration date for FBA shipments
ALTER TABLE public.inventory 
ADD COLUMN IF NOT EXISTS requires_expiration boolean DEFAULT false;

-- Add a comment explaining the column
COMMENT ON COLUMN public.inventory.requires_expiration IS 'Whether this product requires an expiration date for FBA shipments (e.g., grocery, vitamins, baby food)';

-- Create an index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_inventory_requires_expiration ON public.inventory(requires_expiration) WHERE requires_expiration = true;