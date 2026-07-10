-- 1) Bust ALL eligibility cache so users immediately get the new ghost-aware result
DELETE FROM public.fba_eligibility_cache
WHERE asin IN (
  SELECT DISTINCT asin
  FROM public.inventory
  WHERE UPPER(COALESCE(listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
    AND COALESCE(available,0)=0 AND COALESCE(reserved,0)=0 AND COALESCE(inbound,0)=0
);

-- 2) Archive ghost SKUs (tombstoned, zero stock) into quarantine
INSERT INTO public.ghost_sku_quarantine
  (user_id, asin, seller_sku, fnsku, reason, previous_listing_status,
   previous_available, previous_reserved, previous_inbound, source_function, raw)
SELECT
  i.user_id, i.asin, i.sku, i.fnsku,
  'one_time_backfill_tombstoned_zero_stock',
  i.listing_status,
  COALESCE(i.available,0), COALESCE(i.reserved,0), COALESCE(i.inbound,0),
  'data_cleanup_migration',
  jsonb_build_object('migrated_at', now())
FROM public.inventory i
WHERE UPPER(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
  AND COALESCE(i.available,0)=0
  AND COALESCE(i.reserved,0)=0
  AND COALESCE(i.inbound,0)=0
  AND i.sku IS NOT NULL
ON CONFLICT (user_id, asin, seller_sku, source_function) DO NOTHING;

-- 3) Delete fnsku_map rows for ghost SKUs (per seller)
DELETE FROM public.fnsku_map fm
USING public.inventory i, public.seller_authorizations sa
WHERE i.user_id = sa.user_id
  AND fm.seller_id = sa.seller_id
  AND fm.marketplace_id = sa.marketplace_id
  AND fm.asin = i.asin
  AND fm.seller_sku = i.sku
  AND UPPER(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
  AND COALESCE(i.available,0)=0 AND COALESCE(i.reserved,0)=0 AND COALESCE(i.inbound,0)=0;

-- 4) Clear wrongly-set fba_blocked flag on currently ACTIVE rows whose ASIN
-- has at least one ghost row (these were poisoned by the old blanket-by-ASIN
-- write path).
UPDATE public.inventory
SET fba_blocked = false, fba_block_reason = NULL, updated_at = now()
WHERE fba_blocked = true
  AND UPPER(COALESCE(listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED')
  AND asin IN (
    SELECT DISTINCT asin FROM public.inventory
    WHERE UPPER(COALESCE(listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
      AND COALESCE(available,0)=0 AND COALESCE(reserved,0)=0 AND COALESCE(inbound,0)=0
  );

UPDATE public.created_listings
SET fba_blocked = false, fba_block_reason = NULL, updated_at = now()
WHERE fba_blocked = true
  AND asin IN (
    SELECT DISTINCT asin FROM public.inventory
    WHERE UPPER(COALESCE(listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
      AND COALESCE(available,0)=0 AND COALESCE(reserved,0)=0 AND COALESCE(inbound,0)=0
  );
