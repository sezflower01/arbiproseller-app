-- Phase 1: Own-BB pending-price tracking (DATA CAPTURE ONLY, no behavior change)
-- Goal: measure whether using the user's own Buy Box price (when verifiably owned and fresh)
-- would produce a more accurate pending estimate than snapshot_price, vs FEC settlement.
-- 15-minute freshness window per user decision.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS bb_estimate_price                numeric,
  ADD COLUMN IF NOT EXISTS bb_estimate_owner_match          boolean,
  ADD COLUMN IF NOT EXISTS bb_estimate_snapshot_age_seconds integer,
  ADD COLUMN IF NOT EXISTS bb_estimate_captured_at          timestamptz,
  ADD COLUMN IF NOT EXISTS bb_estimate_qualified            boolean,
  ADD COLUMN IF NOT EXISTS bb_estimate_marketplace          text,
  ADD COLUMN IF NOT EXISTS bb_estimate_snapshot_fetched_at  timestamptz,
  ADD COLUMN IF NOT EXISTS bb_estimate_buybox_is_fba        boolean,
  ADD COLUMN IF NOT EXISTS bb_estimate_snapshot_id          uuid;

COMMENT ON COLUMN public.sales_orders.bb_estimate_price IS
  'Phase-1 own-BB tracking: BB price from the most recent repricer_competitor_snapshots row taken WITHIN 15 minutes BEFORE order_date. Tracking only — never used by Live Sales / repricer / fees in Phase 1.';
COMMENT ON COLUMN public.sales_orders.bb_estimate_owner_match IS
  'True when buybox_seller_id on the snapshot == our seller_authorizations.seller_id for this user+marketplace at order time.';
COMMENT ON COLUMN public.sales_orders.bb_estimate_qualified IS
  'True when snapshot is ≤15 min old AND owner_match AND fulfillment matches (FBA order → buybox_is_fba=true). This is the row included in the accuracy report.';
COMMENT ON COLUMN public.sales_orders.bb_estimate_snapshot_age_seconds IS
  'order_date − snapshot.fetched_at, in seconds. Negative values (snapshot after order) are stored as-is but disqualify the row.';

-- Index to make the future accuracy report fast: pull qualified rows with settlement for delta calc.
CREATE INDEX IF NOT EXISTS idx_sales_orders_bb_estimate_qualified
  ON public.sales_orders (bb_estimate_qualified, order_date DESC)
  WHERE bb_estimate_qualified = true;