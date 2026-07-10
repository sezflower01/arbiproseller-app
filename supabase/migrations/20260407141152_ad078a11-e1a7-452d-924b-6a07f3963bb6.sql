
-- Step 1: Add 'history_restore' to the allowed source values
ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_source_check;
ALTER TABLE public.inventory ADD CONSTRAINT inventory_source_check CHECK (source IN ('manual', 'amazon_sync', 'amazon_sync_fbm', 'preserved_db', 'history_restore'));

-- Step 2: Restore stock from the most recent positive duplicate into MISMATCH zero rows
-- Uses a CTE to find the best donor row per ASIN+SKU
WITH best_donor AS (
  SELECT DISTINCT ON (i2.asin, i2.sku)
    i2.asin, i2.sku, i2.available, i2.reserved, i2.inbound, i2.updated_at
  FROM inventory i2
  WHERE (i2.available > 0 OR i2.reserved > 0 OR i2.inbound > 0)
  ORDER BY i2.asin, i2.sku, i2.updated_at DESC
),
targets AS (
  SELECT DISTINCT ON (i1.asin, i1.sku) i1.id
  FROM inventory i1
  JOIN best_donor d ON d.asin = i1.asin AND d.sku = i1.sku
  WHERE i1.listing_status = 'MISMATCH'
    AND i1.available = 0 AND i1.reserved = 0 AND i1.inbound = 0
  ORDER BY i1.asin, i1.sku, i1.updated_at DESC
)
UPDATE inventory i
SET available = d.available,
    reserved = d.reserved,
    inbound = d.inbound,
    source = 'history_restore',
    listing_status = 'MISMATCH'
FROM targets t
JOIN best_donor d ON (
  SELECT asin FROM inventory WHERE id = t.id) = d.asin
  AND (SELECT sku FROM inventory WHERE id = t.id) = d.sku
WHERE i.id = t.id;

-- Step 3: Remove duplicate rows, keeping only the most recently updated per user_id+asin+sku
DELETE FROM inventory
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, asin, sku) id
  FROM inventory
  ORDER BY user_id, asin, sku, updated_at DESC
);
