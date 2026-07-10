ALTER TABLE public.created_listings
  ADD COLUMN IF NOT EXISTS validation_warning text;