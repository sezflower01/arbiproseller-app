-- Backfill: correct inventory-sourced order_price_snapshots / asin_price_history
-- rows mislabeled with marketplace-native currency instead of USD.
--
-- Root cause (fixed forward in supabase/functions/fetch-live-orders/index.ts,
-- commits d1623fb and b08a03c): inventory.price is always USD regardless of
-- marketplace, but the snapshot-capture code tagged inventory-sourced
-- snapshots with the marketplace's native currency code for non-US orders.
-- Downstream consumers (asin_price_history.price_usd, and the
-- estimated_price/locked_est_price readers) then divided an already-USD
-- value by the FX rate a second time, silently shrinking it (e.g. MX$19.00
-- read as MXN and divided by ~17.37 -> $1.09).
--
-- This migration only re-tags rows and recomputes the derived USD column;
-- it never changes the underlying stored price number, since that number
-- was always the correct raw USD amount from inventory — only its currency
-- label (and the label-derived price_usd) was wrong.
--
-- Scope is restricted to snapshot_source = 'inventory' / source =
-- 'order_discovery', which are the only write paths affected by the bug.
-- pricing_api- and orders_api-sourced rows (genuinely native) are untouched.

-- 1) order_price_snapshots: fix the currency tag. The stored price itself
--    (snapshot_item_price / snapshot_price / snapshot_shipping_price) is
--    unchanged.
UPDATE public.order_price_snapshots
SET
  currency_code = 'USD',
  currency = 'USD',
  fx_rate_used = NULL
WHERE snapshot_source = 'inventory'
  AND currency_code IS DISTINCT FROM 'USD';

-- 2) asin_price_history: fix the currency tag AND recompute price_usd, which
--    was derived from the wrong tag (listing_price / fx_rate instead of
--    listing_price as-is).
UPDATE public.asin_price_history
SET
  currency_code = 'USD',
  price_usd = ROUND(listing_price::numeric, 2),
  fx_rate = NULL
WHERE source = 'order_discovery'
  AND currency_code IS DISTINCT FROM 'USD';

-- Note: sales_orders.estimated_price / locked_est_price were audited
-- separately. The only row tracing to this exact bug lineage
-- (701-2952613-3007466) already has a correct locked_est_price from a later,
-- independent write path, which readers already prefer — no sales_orders
-- correction is needed as part of this migration.
