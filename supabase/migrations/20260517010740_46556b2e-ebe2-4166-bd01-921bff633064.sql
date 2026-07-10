ALTER TABLE public.created_listings
ADD COLUMN IF NOT EXISTS received_quantity integer;

COMMENT ON COLUMN public.created_listings.received_quantity IS 'Physically received from supplier. NULL = not yet recorded; callers fall back to units (ordered).';