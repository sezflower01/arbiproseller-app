
-- Phase 1: single-order repair for 702-4519782-1142614 (CA marketplace)
-- Real ItemPrice CA$ 34.51 -> USD $24.88 at FX 1.387 (confirmed in Seller Central)
-- Per Sales Currency Contract: sold_price is USD (native flip pending; out of scope here)
UPDATE public.sales_orders
SET
  sold_price          = 24.88,
  item_price          = 24.88,
  total_sale_amount   = 24.88,
  estimated_price     = NULL,
  price_source        = 'orders_api_ca_manual_repair',
  price_confidence    = 'CONFIRMED',
  price_calc_mode     = 'orders_api',
  needs_price_enrich  = false,
  pending_enrich_attempts    = 0,
  pending_enrich_last_error  = NULL,
  locked_est_price    = NULL,
  locked_from         = NULL,
  price_locked_at     = NULL,
  status              = 'shipped',
  order_status        = 'Shipped',
  status_source       = 'manual_repair',
  last_status_sync_at = now(),
  updated_at          = now()
WHERE order_id = '702-4519782-1142614';
