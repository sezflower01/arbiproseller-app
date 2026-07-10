-- Add repricer fields to inventory table
ALTER TABLE public.inventory 
ADD COLUMN IF NOT EXISTS min_price numeric,
ADD COLUMN IF NOT EXISTS max_price numeric,
ADD COLUMN IF NOT EXISTS my_price numeric,
ADD COLUMN IF NOT EXISTS amazon_price numeric,
ADD COLUMN IF NOT EXISTS last_price_update_status text,
ADD COLUMN IF NOT EXISTS last_price_update_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS last_price_confirmed_at timestamp with time zone;