-- Add date_created column to created_listings table
ALTER TABLE public.created_listings 
ADD COLUMN date_created DATE;