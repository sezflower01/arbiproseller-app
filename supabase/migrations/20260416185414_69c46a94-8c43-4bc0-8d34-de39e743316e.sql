ALTER TABLE public.keepa_simple_products
  ADD COLUMN IF NOT EXISTS new_offer_count integer,
  ADD COLUMN IF NOT EXISTS fba_offer_count integer,
  ADD COLUMN IF NOT EXISTS fbm_offer_count integer;

CREATE INDEX IF NOT EXISTS idx_keepa_simple_products_fba_offer_count ON public.keepa_simple_products(fba_offer_count);
CREATE INDEX IF NOT EXISTS idx_keepa_simple_products_new_offer_count ON public.keepa_simple_products(new_offer_count);