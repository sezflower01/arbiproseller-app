-- Drop the existing constraint
ALTER TABLE public.inventory DROP CONSTRAINT inventory_source_check;

-- Re-create with FBM source included
ALTER TABLE public.inventory ADD CONSTRAINT inventory_source_check 
  CHECK (source = ANY (ARRAY['manual'::text, 'amazon_sync'::text, 'amazon_sync_fbm'::text]));