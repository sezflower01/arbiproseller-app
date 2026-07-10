-- Add BSR (Best Seller Rank) column to inventory table
ALTER TABLE public.inventory 
ADD COLUMN IF NOT EXISTS bsr integer DEFAULT NULL;

-- Add index for BSR sorting/filtering
CREATE INDEX IF NOT EXISTS idx_inventory_bsr ON public.inventory(bsr);

-- Add last_bsr_sync_at column to track when BSR was last fetched
ALTER TABLE public.inventory 
ADD COLUMN IF NOT EXISTS last_bsr_sync_at timestamp with time zone DEFAULT NULL;

COMMENT ON COLUMN public.inventory.bsr IS 'Best Seller Rank from Amazon';
COMMENT ON COLUMN public.inventory.last_bsr_sync_at IS 'Timestamp of last BSR sync from Amazon';