UPDATE public.inventory
SET 
  preserved_since = NULL,
  source = 'amazon_sync',
  listing_status = CASE 
    WHEN (available > 0 OR reserved > 0) THEN 'ACTIVE'
    ELSE 'INACTIVE'
  END,
  updated_at = now()
WHERE source = 'preserved_db' OR preserved_since IS NOT NULL;