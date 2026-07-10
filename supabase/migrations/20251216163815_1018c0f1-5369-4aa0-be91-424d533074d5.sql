-- Add shipping_label_fee column to sales_orders for FBM Buy Shipping costs
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS shipping_label_fee numeric DEFAULT 0;