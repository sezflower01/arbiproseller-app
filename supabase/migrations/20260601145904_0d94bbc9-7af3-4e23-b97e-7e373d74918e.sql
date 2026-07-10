
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS shipping_label_fee_source text,
  ADD COLUMN IF NOT EXISTS shipping_label_fee_synced_at timestamptz;

COMMENT ON COLUMN public.sales_orders.shipping_label_fee_source IS 'Origin of shipping_label_fee: amazon | manual | settlement';
COMMENT ON COLUMN public.sales_orders.shipping_label_fee_synced_at IS 'Last time shipping_label_fee was set or confirmed';
