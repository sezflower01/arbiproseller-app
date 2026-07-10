-- Drop the old ASIN-based unique constraint
DROP INDEX IF EXISTS idx_repricer_assignments_unique;

-- Create new SKU-based unique constraint
CREATE UNIQUE INDEX idx_repricer_assignments_unique 
ON public.repricer_assignments (user_id, sku, marketplace) 
WHERE sku IS NOT NULL;

-- Add a secondary index for ASIN lookups (non-unique)
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_asin_marketplace 
ON public.repricer_assignments (user_id, asin, marketplace);