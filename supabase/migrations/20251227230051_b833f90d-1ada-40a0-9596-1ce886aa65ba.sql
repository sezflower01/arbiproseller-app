-- Add status column to inventory table
ALTER TABLE public.inventory 
ADD COLUMN IF NOT EXISTS listing_status text DEFAULT 'unknown';

-- Add index for filtering by status
CREATE INDEX IF NOT EXISTS idx_inventory_listing_status ON public.inventory(listing_status);

-- Add comment explaining the column
COMMENT ON COLUMN public.inventory.listing_status IS 'Amazon listing status: ACTIVE, INACTIVE, INCOMPLETE, or unknown';