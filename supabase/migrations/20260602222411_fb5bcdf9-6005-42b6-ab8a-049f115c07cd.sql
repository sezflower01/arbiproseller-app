-- =====================================================================
-- Phase 2: Live Sales Summary Cache (idempotent retry)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.live_sales_summary (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  business_date DATE NOT NULL,
  marketplace TEXT NOT NULL,
  orders_count INTEGER NOT NULL DEFAULT 0,
  units_count INTEGER NOT NULL DEFAULT 0,
  cancelled_orders INTEGER NOT NULL DEFAULT 0,
  gross_revenue_native NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_revenue_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_fees_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  referral_fee_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  fba_fee_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  closing_fee_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  shipping_label_fee_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  refund_amount_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  refund_count INTEGER NOT NULL DEFAULT 0,
  cogs_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_profit_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_profit_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  pending_revenue_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  pending_orders INTEGER NOT NULL DEFAULT 0,
  pending_units INTEGER NOT NULL DEFAULT 0,
  low_confidence_pending_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  price_confidence_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  fees_invalid_count INTEGER NOT NULL DEFAULT 0,
  suspicious_half_price_count INTEGER NOT NULL DEFAULT 0,
  source_row_count INTEGER NOT NULL DEFAULT 0,
  summary_version INTEGER NOT NULL DEFAULT 1,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT live_sales_summary_unique UNIQUE (user_id, business_date, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_live_sales_summary_user_date
  ON public.live_sales_summary (user_id, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_live_sales_summary_computed_at
  ON public.live_sales_summary (computed_at);

GRANT SELECT ON public.live_sales_summary TO authenticated;
GRANT ALL ON public.live_sales_summary TO service_role;

ALTER TABLE public.live_sales_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own live_sales_summary" ON public.live_sales_summary;
CREATE POLICY "Users read own live_sales_summary"
  ON public.live_sales_summary FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages live_sales_summary" ON public.live_sales_summary;
CREATE POLICY "Service role manages live_sales_summary"
  ON public.live_sales_summary FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_live_sales_summary_updated_at ON public.live_sales_summary;
CREATE TRIGGER update_live_sales_summary_updated_at
  BEFORE UPDATE ON public.live_sales_summary
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.live_sales_today_by_asin (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  business_date DATE NOT NULL,
  marketplace TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  revenue_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
  summary_version INTEGER NOT NULL DEFAULT 1,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT live_sales_today_by_asin_unique
    UNIQUE (user_id, asin, business_date, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_live_sales_today_by_asin_lookup
  ON public.live_sales_today_by_asin (user_id, asin, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_live_sales_today_by_asin_user_date
  ON public.live_sales_today_by_asin (user_id, business_date DESC);

GRANT SELECT ON public.live_sales_today_by_asin TO authenticated;
GRANT ALL ON public.live_sales_today_by_asin TO service_role;

ALTER TABLE public.live_sales_today_by_asin ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own live_sales_today_by_asin" ON public.live_sales_today_by_asin;
CREATE POLICY "Users read own live_sales_today_by_asin"
  ON public.live_sales_today_by_asin FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages live_sales_today_by_asin" ON public.live_sales_today_by_asin;
CREATE POLICY "Service role manages live_sales_today_by_asin"
  ON public.live_sales_today_by_asin FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_live_sales_today_by_asin_updated_at ON public.live_sales_today_by_asin;
CREATE TRIGGER update_live_sales_today_by_asin_updated_at
  BEFORE UPDATE ON public.live_sales_today_by_asin
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- Covering index on sales_orders for per-ASIN velocity query
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sales_orders_user_asin_date
  ON public.sales_orders (user_id, asin, order_date DESC);