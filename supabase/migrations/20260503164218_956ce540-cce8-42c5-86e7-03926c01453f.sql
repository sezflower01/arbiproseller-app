-- Allow separate repricer state per SKU on the same ASIN/marketplace
ALTER TABLE public.repricer_assignments
  DROP CONSTRAINT IF EXISTS uq_assignment_asin_marketplace_user;

DROP INDEX IF EXISTS public.uq_assignment_asin_marketplace_user;
DROP INDEX IF EXISTS public.idx_repricer_assignments_unique;

-- Keep fast ASIN lookup without enforcing ASIN-only uniqueness.
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_user_asin_marketplace
  ON public.repricer_assignments(user_id, asin, marketplace);

-- Preserve ASIN-level uniqueness only for rows that truly have no SKU.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repricer_assignments_user_asin_marketplace_no_sku
  ON public.repricer_assignments(user_id, asin, marketplace)
  WHERE sku IS NULL OR btrim(sku) = '';

-- Store the exact offer identity detected from Amazon so UI/backend can prove New vs Used/FBA vs FBM mapping.
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS detected_offer_sku text,
  ADD COLUMN IF NOT EXISTS detected_offer_asin text,
  ADD COLUMN IF NOT EXISTS detected_offer_condition text,
  ADD COLUMN IF NOT EXISTS detected_offer_fulfillment text,
  ADD COLUMN IF NOT EXISTS detected_offer_mapping_source text,
  ADD COLUMN IF NOT EXISTS detected_offer_seller_id text,
  ADD COLUMN IF NOT EXISTS detected_offer_price numeric,
  ADD COLUMN IF NOT EXISTS detected_offer_condition_match boolean,
  ADD COLUMN IF NOT EXISTS detected_offer_fulfillment_match boolean,
  ADD COLUMN IF NOT EXISTS detected_offer_sku_match boolean,
  ADD COLUMN IF NOT EXISTS detected_offer_is_ambiguous boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS detected_offer_block_reason text,
  ADD COLUMN IF NOT EXISTS detected_offer_checked_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_offer_identity_review
  ON public.repricer_assignments(user_id, marketplace, detected_offer_is_ambiguous)
  WHERE detected_offer_is_ambiguous = true;