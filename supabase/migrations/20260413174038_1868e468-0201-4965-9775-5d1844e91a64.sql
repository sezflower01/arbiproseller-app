
CREATE TABLE public.created_listing_purchases (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES public.created_listings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  note TEXT,
  purchase_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.created_listing_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own purchases"
ON public.created_listing_purchases FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own purchases"
ON public.created_listing_purchases FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own purchases"
ON public.created_listing_purchases FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own purchases"
ON public.created_listing_purchases FOR DELETE
USING (auth.uid() = user_id);

CREATE TRIGGER update_listing_purchases_updated_at
BEFORE UPDATE ON public.created_listing_purchases
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_listing_purchases_listing_id ON public.created_listing_purchases(listing_id);
CREATE INDEX idx_listing_purchases_user_id ON public.created_listing_purchases(user_id);
