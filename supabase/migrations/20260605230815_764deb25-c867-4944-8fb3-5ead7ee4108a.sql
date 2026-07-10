
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS promotion_discount NUMERIC(14,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_discount_native NUMERIC(14,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_discount_currency TEXT,
  ADD COLUMN IF NOT EXISTS promotion_discount_source TEXT,
  ADD COLUMN IF NOT EXISTS promotion_discount_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sales_orders_promo_discount_idx
  ON public.sales_orders (user_id, order_date)
  WHERE promotion_discount IS NOT NULL AND promotion_discount <> 0;

COMMENT ON COLUMN public.sales_orders.promotion_discount IS 'Amazon PromotionDiscount in USD (coupons, lightning deals, automatic rebates). Subtract from revenue when computing profit.';
COMMENT ON COLUMN public.sales_orders.promotion_discount_native IS 'PromotionDiscount in the order''s local currency (MXN/CAD/BRL/etc).';
COMMENT ON COLUMN public.sales_orders.promotion_discount_source IS 'orders_itemprice | orders_pending | fec_settlement | backfill';
