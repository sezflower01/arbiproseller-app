-- Create a separate table for manually created listings
CREATE TABLE public.created_listings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT NOT NULL,
  fnsku TEXT,
  title TEXT NOT NULL,
  image_url TEXT,
  price NUMERIC,
  cost NUMERIC,
  amount NUMERIC,
  units INTEGER,
  supplier_links JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.created_listings ENABLE ROW LEVEL SECURITY;

-- Users can manage their own created listings
CREATE POLICY "Users can manage their own created listings"
ON public.created_listings
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add trigger for updated_at
CREATE TRIGGER update_created_listings_updated_at
BEFORE UPDATE ON public.created_listings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for better query performance
CREATE INDEX idx_created_listings_user_id ON public.created_listings(user_id);
CREATE INDEX idx_created_listings_asin ON public.created_listings(asin);