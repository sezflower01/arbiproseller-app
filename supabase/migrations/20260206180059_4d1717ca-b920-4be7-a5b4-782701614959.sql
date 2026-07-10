
-- Drop the COALESCE-based index (PostgREST can't use it for onConflict)
DROP INDEX IF EXISTS idx_asin_my_price_cache_sku_unique;

-- Set default for seller_sku so we never have NULLs (enables standard unique constraint)
UPDATE public.asin_my_price_cache SET seller_sku = '__NO_SKU__' WHERE seller_sku IS NULL;
ALTER TABLE public.asin_my_price_cache ALTER COLUMN seller_sku SET DEFAULT '__NO_SKU__';
ALTER TABLE public.asin_my_price_cache ALTER COLUMN seller_sku SET NOT NULL;

-- Create standard unique constraint that PostgREST can use for onConflict
ALTER TABLE public.asin_my_price_cache ADD CONSTRAINT asin_my_price_cache_user_asin_mkt_sku_key UNIQUE (user_id, asin, marketplace_id, seller_sku);
