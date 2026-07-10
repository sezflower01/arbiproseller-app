ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS shipping_label_fee_poll_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_label_fee_last_polled_at timestamptz;

COMMENT ON COLUMN public.sales_orders.shipping_label_fee_source IS 'Origin of shipping_label_fee: buy_shipping_rate | amazon_finances | settlement | manual';
COMMENT ON COLUMN public.sales_orders.shipping_label_fee_poll_attempts IS 'How many times the background auto-poller has tried to fetch a label fee for this FBM order';
COMMENT ON COLUMN public.sales_orders.shipping_label_fee_last_polled_at IS 'Last time the background auto-poller attempted to resolve the label fee';

CREATE INDEX IF NOT EXISTS idx_sales_orders_label_fee_poll
  ON public.sales_orders (user_id, order_date)
  WHERE fulfillment_channel = 'MFN'
    AND (shipping_label_fee IS NULL OR shipping_label_fee = 0)
    AND shipping_label_fee_source IS DISTINCT FROM 'manual';