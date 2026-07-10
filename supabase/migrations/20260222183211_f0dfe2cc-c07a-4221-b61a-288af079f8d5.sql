
-- ============================================================
-- #3: Daily sales rollup table (incremental, upsert-friendly)
-- ============================================================
CREATE TABLE public.asin_sales_daily (
  user_id UUID NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  date DATE NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT,
  units INTEGER NOT NULL DEFAULT 0,
  revenue NUMERIC NOT NULL DEFAULT 0,
  last_updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, marketplace, date, asin)
);

-- Enable RLS
ALTER TABLE public.asin_sales_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own daily sales"
  ON public.asin_sales_daily FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for repricer "today" lookup (the main use case)
CREATE INDEX idx_asin_sales_daily_today
  ON public.asin_sales_daily (user_id, date, asin);

-- ============================================================
-- #5: Composite indexes on hot tables
-- ============================================================

-- repricer_assignments
CREATE INDEX IF NOT EXISTS idx_ra_user_mp_enabled
  ON public.repricer_assignments (user_id, marketplace, is_enabled);

CREATE INDEX IF NOT EXISTS idx_ra_user_mp_asin
  ON public.repricer_assignments (user_id, marketplace, asin);

CREATE INDEX IF NOT EXISTS idx_ra_user_mp_sku
  ON public.repricer_assignments (user_id, marketplace, sku);

-- inventory
CREATE INDEX IF NOT EXISTS idx_inv_user_asin
  ON public.inventory (user_id, asin);

CREATE INDEX IF NOT EXISTS idx_inv_user_sku
  ON public.inventory (user_id, sku);

-- sales_orders (the "sold today" source)
CREATE INDEX IF NOT EXISTS idx_so_user_date
  ON public.sales_orders (user_id, order_date);

CREATE INDEX IF NOT EXISTS idx_so_user_date_asin
  ON public.sales_orders (user_id, order_date, asin);

-- asin_my_price_cache
CREATE INDEX IF NOT EXISTS idx_mpc_user_mp_asin
  ON public.asin_my_price_cache (user_id, marketplace_id, asin);

-- asin_fee_cache
CREATE INDEX IF NOT EXISTS idx_afc_user_mp_asin
  ON public.asin_fee_cache (user_id, marketplace, asin);

-- financial_events_cache
CREATE INDEX IF NOT EXISTS idx_fec_user_date
  ON public.financial_events_cache (user_id, event_date);
