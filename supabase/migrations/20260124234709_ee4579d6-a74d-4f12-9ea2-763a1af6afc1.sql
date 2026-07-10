-- Alter order_price_snapshots to split item vs shipping and add proper currency/FX tracking
-- This corrects the design per ChatGPT's recommendations

-- Add new columns for split pricing
ALTER TABLE public.order_price_snapshots 
  ADD COLUMN IF NOT EXISTS snapshot_item_price numeric,
  ADD COLUMN IF NOT EXISTS snapshot_shipping_price numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fx_rate_used numeric,
  ADD COLUMN IF NOT EXISTS currency_code text;

-- Migrate existing data: move snapshot_price to snapshot_item_price
UPDATE public.order_price_snapshots 
SET snapshot_item_price = snapshot_price,
    snapshot_shipping_price = 0,
    currency_code = COALESCE(currency, 'USD')
WHERE snapshot_item_price IS NULL;

-- Update snapshot_source enum comment for clarity
COMMENT ON COLUMN public.order_price_snapshots.snapshot_source IS 
  'Source of the snapshot: orders_api (from GetOrderItems), pricing_api (from Pricing API estimate), inventory (fallback to inventory.price)';

-- Update table comment
COMMENT ON TABLE public.order_price_snapshots IS 
  'Permanently stores listing prices at the exact moment an order is first discovered.
   Splits item_price and shipping_price to ensure ROI calculations only use item revenue.
   For non-US orders, stores currency_code and fx_rate_used for accurate USD conversion.
   Snapshot sources: orders_api (best), pricing_api (estimate), inventory (fallback).';