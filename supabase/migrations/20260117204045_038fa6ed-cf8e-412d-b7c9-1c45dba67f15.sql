-- Add new columns to sales_orders for price/fee tracking
ALTER TABLE public.sales_orders
ADD COLUMN IF NOT EXISTS item_price numeric,
ADD COLUMN IF NOT EXISTS shipping_price numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS roi_source text,
ADD COLUMN IF NOT EXISTS is_multi_item_order boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS price_calc_mode text;

-- Add comments for clarity
COMMENT ON COLUMN public.sales_orders.item_price IS 'Pure item price without shipping (for ROI calculation)';
COMMENT ON COLUMN public.sales_orders.shipping_price IS 'Shipping price component (separate from item_price)';
COMMENT ON COLUMN public.sales_orders.roi_source IS 'Source of ROI calculation: actual, estimated, unknown';
COMMENT ON COLUMN public.sales_orders.is_multi_item_order IS 'True if order has multiple items (OrderTotal/qty unsafe)';
COMMENT ON COLUMN public.sales_orders.price_calc_mode IS 'How price was calculated: orders_itemprice, order_total_div_qty, skipped_multi_item, inventory_fallback, unknown';

-- Create fee cache table for storing fixed FBA + referral rates per ASIN
CREATE TABLE IF NOT EXISTS public.asin_fee_cache (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  fba_fee_fixed numeric NOT NULL DEFAULT 0,
  referral_rate numeric NOT NULL DEFAULT 0,
  is_media boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT asin_fee_cache_unique UNIQUE (user_id, asin, marketplace)
);

-- Enable RLS
ALTER TABLE public.asin_fee_cache ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view their own fee cache"
ON public.asin_fee_cache
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own fee cache"
ON public.asin_fee_cache
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own fee cache"
ON public.asin_fee_cache
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own fee cache"
ON public.asin_fee_cache
FOR DELETE
USING (auth.uid() = user_id);

-- Add index for fast lookups
CREATE INDEX IF NOT EXISTS idx_asin_fee_cache_lookup ON public.asin_fee_cache(user_id, asin, marketplace);

-- Add trigger for updated_at
CREATE TRIGGER update_asin_fee_cache_updated_at
BEFORE UPDATE ON public.asin_fee_cache
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();