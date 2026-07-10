
-- Pass 1: match by user_id + SKU
WITH cl_by_sku AS (
  SELECT DISTINCT ON (user_id, sku)
    user_id, sku,
    COALESCE(NULLIF(amount, 0),
      CASE WHEN units > 0 AND cost > 0 THEN cost / units END) AS unit_cost
  FROM public.created_listings
  WHERE sku IS NOT NULL AND sku <> ''
  ORDER BY user_id, sku, updated_at DESC NULLS LAST
)
UPDATE public.inventory i
SET cost = c.unit_cost, updated_at = now()
FROM cl_by_sku c
WHERE c.user_id = i.user_id
  AND c.sku = i.sku
  AND c.unit_cost > 0
  AND (i.cost IS NULL OR i.cost = 0);

-- Pass 2: remaining rows match by user_id + ASIN
WITH cl_by_asin AS (
  SELECT DISTINCT ON (user_id, asin)
    user_id, asin,
    COALESCE(NULLIF(amount, 0),
      CASE WHEN units > 0 AND cost > 0 THEN cost / units END) AS unit_cost
  FROM public.created_listings
  WHERE asin IS NOT NULL AND asin <> ''
  ORDER BY user_id, asin, updated_at DESC NULLS LAST
)
UPDATE public.inventory i
SET cost = c.unit_cost, updated_at = now()
FROM cl_by_asin c
WHERE c.user_id = i.user_id
  AND c.asin = i.asin
  AND c.unit_cost > 0
  AND (i.cost IS NULL OR i.cost = 0);
