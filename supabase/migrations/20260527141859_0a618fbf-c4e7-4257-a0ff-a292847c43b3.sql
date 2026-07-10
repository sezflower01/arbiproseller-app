
-- Repair sales_orders for user sezflower01: write unit_cost from authoritative
-- sources (created_listings.amount, inventory manual cost with units>0, etc.)
-- and clear cost_invalid + recompute total_cost. Data-only repair; no schema change.

DO $$
DECLARE
  v_uid uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  v_updated int;
BEGIN

-- Build a candidate cost map (one row per (asin, sku) pair) using the same
-- priority as backfill-orders-cost edge function:
--   1. inventory manual cost (unit_cost_manual=true, units>0, cost>0) → cost
--   2. created_listings: amount (unit cost) if non-null and >=0, else cost/units
--   3. inventory non-manual: cost if >0, else amount/units
CREATE TEMP TABLE _cost_map ON COMMIT DROP AS
WITH inv_manual AS (
  SELECT asin, sku, cost::numeric AS unit_cost, 1 AS prio
  FROM inventory
  WHERE user_id = v_uid AND unit_cost_manual = true AND COALESCE(units,0) > 0 AND COALESCE(cost,0) > 0
),
listings AS (
  SELECT DISTINCT ON (asin, sku)
    asin, sku,
    CASE
      WHEN amount IS NOT NULL AND amount >= 0 THEN amount::numeric
      WHEN COALESCE(cost,0) > 0 AND COALESCE(units,0) > 0 THEN (cost::numeric / units::numeric)
      ELSE NULL
    END AS unit_cost,
    2 AS prio
  FROM created_listings
  WHERE user_id = v_uid
  ORDER BY asin, sku, updated_at DESC
),
inv_auto AS (
  SELECT asin, sku,
    CASE
      WHEN COALESCE(cost,0) > 0 THEN cost::numeric
      WHEN COALESCE(amount,0) > 0 AND COALESCE(units,0) > 0 THEN (amount::numeric / units::numeric)
      ELSE NULL
    END AS unit_cost,
    3 AS prio
  FROM inventory
  WHERE user_id = v_uid AND (unit_cost_manual IS DISTINCT FROM true OR COALESCE(units,0) = 0)
),
all_cands AS (
  SELECT * FROM inv_manual
  UNION ALL SELECT * FROM listings WHERE unit_cost IS NOT NULL AND unit_cost > 0
  UNION ALL SELECT * FROM inv_auto  WHERE unit_cost IS NOT NULL AND unit_cost > 0
),
ranked AS (
  SELECT asin, sku, unit_cost,
    ROW_NUMBER() OVER (PARTITION BY asin, sku ORDER BY prio) AS rn
  FROM all_cands
)
SELECT asin, sku, unit_cost FROM ranked WHERE rn = 1;

CREATE INDEX ON _cost_map (asin);
CREATE INDEX ON _cost_map (sku);

-- Also build sku-only and asin-only fallbacks
CREATE TEMP TABLE _cost_by_asin ON COMMIT DROP AS
SELECT asin, MIN(unit_cost) AS unit_cost FROM _cost_map WHERE asin IS NOT NULL GROUP BY asin;
CREATE INDEX ON _cost_by_asin (asin);

CREATE TEMP TABLE _cost_by_sku ON COMMIT DROP AS
SELECT sku, MIN(unit_cost) AS unit_cost FROM _cost_map WHERE sku IS NOT NULL GROUP BY sku;
CREATE INDEX ON _cost_by_sku (sku);

-- Apply repair
WITH broken AS (
  SELECT so.id, so.asin, so.sku, COALESCE(so.quantity,1) AS qty
  FROM sales_orders so
  WHERE so.user_id = v_uid
    AND (so.unit_cost IS NULL OR so.unit_cost = 0)
    AND so.order_id NOT LIKE '%-REFUND'
),
resolved AS (
  SELECT b.id, b.qty,
    COALESCE(
      (SELECT unit_cost FROM _cost_map  m WHERE m.asin = b.asin AND m.sku = b.sku LIMIT 1),
      (SELECT unit_cost FROM _cost_by_sku  s WHERE s.sku  = b.sku  LIMIT 1),
      (SELECT unit_cost FROM _cost_by_sku  s WHERE s.sku  = b.asin LIMIT 1), -- asin field holds SKU
      (SELECT unit_cost FROM _cost_by_asin a WHERE a.asin = b.asin LIMIT 1)
    ) AS uc
  FROM broken b
),
to_fix AS (
  SELECT id, qty, uc FROM resolved WHERE uc IS NOT NULL AND uc > 0
)
UPDATE sales_orders so
SET unit_cost = tf.uc,
    total_cost = tf.uc * tf.qty,
    cost_invalid = false
FROM to_fix tf
WHERE so.id = tf.id;

GET DIAGNOSTICS v_updated = ROW_COUNT;
RAISE NOTICE 'repaired_unit_cost_rows=%', v_updated;

-- Now run the auto-resolver for this user
PERFORM auto_resolve_business_health_issues(v_uid);

END $$;
