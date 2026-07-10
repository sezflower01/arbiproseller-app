-- Backfill inventory image_url from created_listings (most complete source)
UPDATE public.inventory i
SET image_url = cl.image_url
FROM (
  SELECT DISTINCT ON (asin) asin, image_url
  FROM public.created_listings
  WHERE image_url IS NOT NULL AND image_url <> ''
  ORDER BY asin, updated_at DESC
) cl
WHERE i.asin = cl.asin
  AND (i.image_url IS NULL OR i.image_url = '');

-- Backfill remaining from sales_orders
UPDATE public.inventory i
SET image_url = so.image_url
FROM (
  SELECT DISTINCT ON (asin) asin, image_url
  FROM public.sales_orders
  WHERE image_url IS NOT NULL AND image_url <> ''
    AND asin IS NOT NULL AND asin <> 'PENDING'
  ORDER BY asin, order_date DESC
) so
WHERE i.asin = so.asin
  AND (i.image_url IS NULL OR i.image_url = '');