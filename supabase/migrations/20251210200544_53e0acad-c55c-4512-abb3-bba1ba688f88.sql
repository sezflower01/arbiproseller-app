-- Add listing_created_at column to inventory table
ALTER TABLE public.inventory 
ADD COLUMN IF NOT EXISTS listing_created_at timestamp with time zone;

-- Add last_inventory_sync_at column to track sync timing
ALTER TABLE public.inventory
ADD COLUMN IF NOT EXISTS last_inventory_sync_at timestamp with time zone;