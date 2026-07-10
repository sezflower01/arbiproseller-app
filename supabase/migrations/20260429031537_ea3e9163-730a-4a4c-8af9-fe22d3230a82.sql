CREATE INDEX IF NOT EXISTS idx_sales_orders_user_order_date_desc
ON public.sales_orders (user_id, order_date DESC);

CREATE INDEX IF NOT EXISTS idx_sales_orders_user_purchase_ts_utc_desc
ON public.sales_orders (user_id, purchase_timestamp_utc DESC);

CREATE INDEX IF NOT EXISTS idx_financial_events_cache_user_event_date_desc
ON public.financial_events_cache (user_id, event_date DESC);