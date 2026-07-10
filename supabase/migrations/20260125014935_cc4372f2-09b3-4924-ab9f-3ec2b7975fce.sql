-- Drop the constraint (not index) that only allows one SKU per ASIN
ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_user_id_asin_unique;

-- Drop the global SKU uniqueness (should be per-user)
ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_sku_key;

-- Create the correct unique constraint: per-user, per-SKU (allows multiple SKUs per ASIN)
CREATE UNIQUE INDEX inventory_user_id_sku_unique ON public.inventory USING btree (user_id, sku);