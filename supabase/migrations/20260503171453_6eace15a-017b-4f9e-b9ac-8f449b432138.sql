
DROP INDEX IF EXISTS public.uq_repricer_eval_acks_user_asin_sku_marketplace;
-- Remove rows that pre-date sku tracking (they would block the new strict unique index)
DELETE FROM public.repricer_eval_acks WHERE sku IS NULL;
ALTER TABLE public.repricer_eval_acks ALTER COLUMN sku SET NOT NULL;
ALTER TABLE public.repricer_eval_acks 
  ADD CONSTRAINT uq_repricer_eval_acks_user_asin_sku_marketplace 
  UNIQUE (user_id, asin, sku, marketplace);
