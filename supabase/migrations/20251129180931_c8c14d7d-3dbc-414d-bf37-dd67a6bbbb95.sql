-- Add unique constraint on user_id and asin for inventory table
ALTER TABLE public.inventory 
ADD CONSTRAINT inventory_user_id_asin_unique UNIQUE (user_id, asin);
