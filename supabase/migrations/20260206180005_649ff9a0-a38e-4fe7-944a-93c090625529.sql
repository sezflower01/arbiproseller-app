
-- Add seller_sku column to asin_my_price_cache for multi-SKU support
ALTER TABLE public.asin_my_price_cache ADD COLUMN IF NOT EXISTS seller_sku text;

-- Drop old unique constraint (user_id, asin, marketplace_id)
ALTER TABLE public.asin_my_price_cache DROP CONSTRAINT IF EXISTS asin_my_price_cache_user_id_asin_marketplace_id_key;

-- Drop any old unique index
DROP INDEX IF EXISTS asin_my_price_cache_user_id_asin_marketplace_id_key;
DROP INDEX IF EXISTS idx_asin_my_price_cache_unique;

-- Create new unique constraint including seller_sku (NULL-safe via COALESCE)
-- We use a unique index with COALESCE so NULL SKUs don't conflict
CREATE UNIQUE INDEX idx_asin_my_price_cache_sku_unique 
ON public.asin_my_price_cache (user_id, asin, marketplace_id, COALESCE(seller_sku, '__NO_SKU__'));
