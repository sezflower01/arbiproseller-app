-- Add category column to asin_items table
ALTER TABLE public.asin_items 
ADD COLUMN category TEXT;

-- Add category column to keepa_items table
ALTER TABLE public.keepa_items 
ADD COLUMN category TEXT;

-- Create index for faster category filtering
CREATE INDEX idx_asin_items_category ON public.asin_items(category);
CREATE INDEX idx_keepa_items_category ON public.keepa_items(category);