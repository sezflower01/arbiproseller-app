-- Backfill unit_cost for existing Amazon-synced disposition rows that have $0 cost.
-- Priority: MFN returns → sales_orders.unit_cost; others → created_listings → inventory.cost.
-- Also auto-accept zero-loss rows (sellable>0, unsellable=0) that are still pending_review.

WITH mfn_cost AS (
  SELECT DISTINCT ON (d.id) d.id, so.unit_cost
  FROM inventory_dispositions d
  JOIN sales_orders so ON so.user_id = d.user_id
    AND (so.asin = d.asin OR so.seller_sku = d.msku)
    AND so.unit_cost > 0
  WHERE d.source = 'amazon_report'
    AND d.disposition_type = 'mfn_return'
    AND COALESCE(d.unit_cost, 0) = 0
  ORDER BY d.id, so.order_date DESC NULLS LAST
)
UPDATE inventory_dispositions d
SET unit_cost = m.unit_cost
FROM mfn_cost m
WHERE d.id = m.id;

WITH cl_cost AS (
  SELECT DISTINCT ON (d.id) d.id,
    CASE
      WHEN COALESCE(cl.amount, -1) >= 0 THEN cl.amount
      WHEN COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0 THEN cl.cost / cl.units
      ELSE 0
    END AS unit_cost
  FROM inventory_dispositions d
  JOIN created_listings cl ON cl.user_id = d.user_id AND cl.asin = d.asin
  WHERE d.source = 'amazon_report'
    AND COALESCE(d.unit_cost, 0) = 0
    AND d.asin IS NOT NULL
  ORDER BY d.id, cl.updated_at DESC NULLS LAST
)
UPDATE inventory_dispositions d
SET unit_cost = c.unit_cost
FROM cl_cost c
WHERE d.id = c.id AND c.unit_cost > 0;

WITH inv_cost AS (
  SELECT DISTINCT ON (d.id) d.id, i.cost AS unit_cost
  FROM inventory_dispositions d
  JOIN inventory i ON i.user_id = d.user_id
    AND (i.sku = d.msku OR i.asin = d.asin)
    AND i.cost > 0
  WHERE d.source = 'amazon_report'
    AND COALESCE(d.unit_cost, 0) = 0
  ORDER BY d.id, (CASE WHEN i.sku = d.msku THEN 0 ELSE 1 END)
)
UPDATE inventory_dispositions d
SET unit_cost = ic.unit_cost
FROM inv_cost ic
WHERE d.id = ic.id;

-- Auto-accept zero-loss synced rows (no unsellable units → no P&L impact)
UPDATE inventory_dispositions
SET status = 'accepted'
WHERE source = 'amazon_report'
  AND status = 'pending_review'
  AND COALESCE(unsellable_qty, 0) = 0
  AND COALESCE(sellable_qty, 0) > 0;