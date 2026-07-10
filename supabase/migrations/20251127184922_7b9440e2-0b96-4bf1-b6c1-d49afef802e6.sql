-- Add condition column to fnsku_map table
ALTER TABLE public.fnsku_map 
ADD COLUMN IF NOT EXISTS condition TEXT;

-- Add index for better query performance when filtering by condition
CREATE INDEX IF NOT EXISTS idx_fnsku_map_condition 
ON public.fnsku_map(condition);

COMMENT ON COLUMN public.fnsku_map.condition IS 'Product condition: NEW, USED - LIKE NEW, USED - VERY GOOD, USED - GOOD, USED - ACCEPTABLE, COLLECTIBLE variants, RENEWED, OEM, etc.';