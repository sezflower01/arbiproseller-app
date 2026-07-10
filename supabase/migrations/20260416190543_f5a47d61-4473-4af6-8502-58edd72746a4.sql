ALTER TABLE public.user_owned_products
  ADD COLUMN IF NOT EXISTS eligibility_status text,
  ADD COLUMN IF NOT EXISTS eligibility_checked_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_user_owned_products_elig_status
  ON public.user_owned_products(user_id, eligibility_status);