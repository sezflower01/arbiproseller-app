
-- Add sku column to repricer_eval_acks for SKU-level uniqueness
ALTER TABLE public.repricer_eval_acks ADD COLUMN IF NOT EXISTS sku text;

-- Drop old (user_id, asin, marketplace) unique constraint and replace with SKU-aware one
ALTER TABLE public.repricer_eval_acks DROP CONSTRAINT IF EXISTS repricer_eval_acks_user_id_asin_marketplace_key;
DROP INDEX IF EXISTS public.repricer_eval_acks_user_id_asin_marketplace_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_repricer_eval_acks_user_asin_sku_marketplace
  ON public.repricer_eval_acks (user_id, asin, COALESCE(sku, ''), marketplace);

CREATE INDEX IF NOT EXISTS idx_eval_acks_user_sku
  ON public.repricer_eval_acks (user_id, sku, marketplace) WHERE sku IS NOT NULL;

-- Add sku column to repricer_competitor_snapshots so New vs Used snapshots don't collide
ALTER TABLE public.repricer_competitor_snapshots ADD COLUMN IF NOT EXISTS sku text;
CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_user_asin_sku_marketplace
  ON public.repricer_competitor_snapshots (user_id, asin, sku, marketplace, fetched_at DESC);
