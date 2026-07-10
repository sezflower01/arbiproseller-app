-- Backfill bb_estimate_* tracking fields for historical sales_orders (last 30 days)
-- Mirrors supabase/functions/_shared/bbOwnEstimate.ts logic.
-- Tracking-only: does NOT touch sold_price/estimated_price/repricer behavior.

WITH mkt AS (
  SELECT * FROM (VALUES
    ('US','ATVPDKIKX0DER'),
    ('CA','A2EUQ1WTGCTBG2'),
    ('MX','A1AM78C64UM0Y8'),
    ('BR','A2Q3Y263D00KWC')
  ) AS m(code, mid)
),
candidates AS (
  SELECT so.id, so.user_id, so.asin, so.marketplace,
         so.purchase_timestamp_utc AS order_ts,
         UPPER(COALESCE(so.fulfillment_channel,'')) AS fc
  FROM public.sales_orders so
  WHERE so.bb_estimate_captured_at IS NULL
    AND so.asin IS NOT NULL
    AND so.marketplace IS NOT NULL
    AND so.purchase_timestamp_utc IS NOT NULL
    AND so.purchase_timestamp_utc >= now() - interval '30 days'
),
own_seller AS (
  SELECT DISTINCT ON (sa.user_id, sa.marketplace_id)
         sa.user_id, sa.marketplace_id, sa.seller_id
  FROM public.seller_authorizations sa
  WHERE sa.is_active = true
  ORDER BY sa.user_id, sa.marketplace_id, sa.updated_at DESC
),
enriched AS (
  SELECT c.*,
         os.seller_id AS own_seller_id,
         s.id            AS snap_id,
         s.fetched_at    AS snap_fetched_at,
         s.buybox_price  AS snap_price,
         s.buybox_seller_id AS snap_seller_id,
         s.buybox_is_fba    AS snap_is_fba
  FROM candidates c
  LEFT JOIN mkt ON mkt.code = c.marketplace
  LEFT JOIN own_seller os
         ON os.user_id = c.user_id AND os.marketplace_id = mkt.mid
  LEFT JOIN LATERAL (
    SELECT id, fetched_at, buybox_price, buybox_seller_id, buybox_is_fba
    FROM public.repricer_competitor_snapshots r
    WHERE r.user_id = c.user_id
      AND r.asin = c.asin
      AND r.marketplace = c.marketplace
      AND r.fetched_at <= c.order_ts
    ORDER BY r.fetched_at DESC
    LIMIT 1
  ) s ON true
),
computed AS (
  SELECT e.id,
         e.snap_id,
         e.snap_fetched_at,
         e.snap_is_fba,
         e.marketplace,
         CASE WHEN e.snap_price IS NOT NULL AND e.snap_price > 0
              THEN ROUND(e.snap_price::numeric, 2) END AS price,
         CASE WHEN e.snap_id IS NULL THEN NULL
              ELSE (e.own_seller_id IS NOT NULL
                    AND e.snap_seller_id IS NOT NULL
                    AND e.snap_seller_id = e.own_seller_id) END AS owner_match,
         CASE WHEN e.snap_id IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (e.order_ts - e.snap_fetched_at))::int END AS age_sec,
         CASE
           WHEN e.snap_id IS NULL THEN false
           WHEN e.snap_price IS NULL OR e.snap_price <= 0 THEN false
           WHEN NOT (e.own_seller_id IS NOT NULL
                     AND e.snap_seller_id IS NOT NULL
                     AND e.snap_seller_id = e.own_seller_id) THEN false
           WHEN EXTRACT(EPOCH FROM (e.order_ts - e.snap_fetched_at)) < 0
                OR EXTRACT(EPOCH FROM (e.order_ts - e.snap_fetched_at)) > 900 THEN false
           WHEN (e.fc IN ('AFN','FBA','AMAZON')) AND e.snap_is_fba IS NOT TRUE THEN false
           WHEN (e.fc IN ('MFN','FBM','MERCHANT')) AND e.snap_is_fba IS NOT FALSE THEN false
           WHEN e.fc NOT IN ('AFN','FBA','AMAZON','MFN','FBM','MERCHANT') THEN false
           ELSE true
         END AS qualified
  FROM enriched e
)
UPDATE public.sales_orders so
SET bb_estimate_captured_at         = now(),
    bb_estimate_marketplace         = c.marketplace,
    bb_estimate_snapshot_id         = c.snap_id,
    bb_estimate_snapshot_fetched_at = c.snap_fetched_at,
    bb_estimate_snapshot_age_seconds= c.age_sec,
    bb_estimate_price               = c.price,
    bb_estimate_owner_match         = c.owner_match,
    bb_estimate_buybox_is_fba       = c.snap_is_fba,
    bb_estimate_qualified           = c.qualified
FROM computed c
WHERE so.id = c.id;