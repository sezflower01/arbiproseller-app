-- One-time backfill: copy image_url from created_listings to inventory where missing
UPDATE public.inventory i
SET image_url = cl.image_url
FROM (
  SELECT DISTINCT ON (asin, user_id) asin, user_id, image_url
  FROM public.created_listings
  WHERE image_url IS NOT NULL AND image_url != ''
  ORDER BY asin, user_id, updated_at DESC
) cl
WHERE i.asin = cl.asin
  AND i.user_id = cl.user_id
  AND (i.image_url IS NULL OR i.image_url = '');