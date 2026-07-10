-- Add shipping_cost column to personalhour_orders table
ALTER TABLE public.personalhour_orders 
ADD COLUMN shipping_cost numeric DEFAULT 0;