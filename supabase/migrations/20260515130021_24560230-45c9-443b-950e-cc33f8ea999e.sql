ALTER TABLE public.still_thinking_listings
ADD COLUMN IF NOT EXISTS linked_created_listing_id uuid REFERENCES public.created_listings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_still_thinking_linked_created_listing
  ON public.still_thinking_listings(linked_created_listing_id);