ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS price_confidence text;

CREATE INDEX IF NOT EXISTS idx_repricer_price_actions_lookup
  ON public.repricer_price_actions(user_id, asin, marketplace, created_at DESC)
  WHERE success = true AND new_price IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_repricer_setting_changes_lookup
  ON public.repricer_setting_changes(user_id, asin, marketplace, field_changed, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_orders_recent_price_lookup
  ON public.sales_orders(user_id, asin, marketplace, order_date DESC)
  WHERE sold_price > 0;