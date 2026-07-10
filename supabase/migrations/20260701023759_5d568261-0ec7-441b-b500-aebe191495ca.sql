-- Permanent prevention: stable idempotency key for FEC-derived refund rows in sales_orders.
-- Prevents the "-REFUND-1..-REFUND-10" duplicate-loop bug where different sync passes
-- created new positional siblings for the same FEC refund event.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS fec_refund_key TEXT;

COMMENT ON COLUMN public.sales_orders.fec_refund_key IS
  'Stable idempotency key for refund rows: refund:{base_order_id}|{asin}|{event_date}. Enforces one refund row per FEC refund event.';

-- Unique guard: same user + same refund event key can only exist once.
-- Partial index so non-refund rows (fec_refund_key IS NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_fec_refund_key_uidx
  ON public.sales_orders (user_id, fec_refund_key)
  WHERE fec_refund_key IS NOT NULL;
