-- Drop the existing unique constraint on seller_id, marketplace_id, asin
ALTER TABLE public.fnsku_map DROP CONSTRAINT IF EXISTS fnsku_map_seller_id_marketplace_id_asin_key;

-- Add a new unique constraint that includes fnsku to allow multiple conditions per ASIN
ALTER TABLE public.fnsku_map ADD CONSTRAINT fnsku_map_seller_marketplace_asin_fnsku_key 
  UNIQUE (seller_id, marketplace_id, asin, fnsku);

-- Also create an index for faster lookups by ASIN
CREATE INDEX IF NOT EXISTS idx_fnsku_map_asin ON public.fnsku_map(asin);