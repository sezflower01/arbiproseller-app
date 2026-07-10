-- Add seller address fields to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS business_name text,
ADD COLUMN IF NOT EXISTS contact_name text,
ADD COLUMN IF NOT EXISTS address_line1 text,
ADD COLUMN IF NOT EXISTS address_line2 text,
ADD COLUMN IF NOT EXISTS city text,
ADD COLUMN IF NOT EXISTS state_code text,
ADD COLUMN IF NOT EXISTS postal_code text,
ADD COLUMN IF NOT EXISTS country_code text DEFAULT 'US',
ADD COLUMN IF NOT EXISTS phone text;