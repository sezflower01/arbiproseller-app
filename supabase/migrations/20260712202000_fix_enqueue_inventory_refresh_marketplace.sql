-- Fixes enqueue_full_inventory_refresh(uuid): it referenced i.marketplace,
-- a column that does not exist on public.inventory (confirmed via full
-- schema dump), so every call threw "column i.marketplace does not exist",
-- silently swallowed by the caller's (enqueue_full_inventory_refresh_all_users)
-- EXCEPTION WHEN OTHERS -> RAISE LOG handler. Net effect: inventory_refresh_queue
-- has never been fed by this scheduled path, regardless of cron cadence or
-- batch_size -- confirmed empty (0 rows, any status) before this fix.
--
-- Marketplace now comes from repricer_assignments (user_id, sku, marketplace)
-- instead, joined on (user_id, sku) -- inventory's own unique key. The old
-- DISTINCT ON (i.asin, i.sku) is removed: even with a working column it would
-- have collapsed every SKU to a single arbitrary marketplace, silently
-- dropping the rest. Confirmed via dry-run this is not an edge case -- 1,340
-- of 1,954 enabled repricer_assignments rows (69%) are additional
-- marketplaces for a SKU that already has at least one other marketplace
-- enabled. Dry-run of this exact join produced 1,858 rows (458 BR / 469 CA /
-- 460 MX / 471 US), matching distinct (sku, marketplace) pairs exactly --
-- zero duplication.
CREATE OR REPLACE FUNCTION public.enqueue_full_inventory_refresh(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  WITH src AS (
    SELECT i.user_id, i.asin, i.sku, ra.marketplace
    FROM public.inventory i
    JOIN public.repricer_assignments ra
      ON ra.user_id = i.user_id
     AND ra.sku = i.sku
     AND ra.is_enabled = true
    WHERE i.user_id = p_user_id
      AND i.asin IS NOT NULL
      AND i.sku IS NOT NULL
      AND COALESCE(i.source, '') <> 'created_listing'
      AND COALESCE(UPPER(i.listing_status), '') <> 'DELETED'
  ),
  ins AS (
    INSERT INTO public.inventory_refresh_queue (user_id, asin, sku, marketplace, status, priority)
    SELECT s.user_id, s.asin, s.sku, s.marketplace, 'pending', 100
    FROM src s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.inventory_refresh_queue q
      WHERE q.user_id = s.user_id
        AND q.asin = s.asin
        AND q.sku = s.sku
        AND q.marketplace = s.marketplace
        AND q.status IN ('pending','running')
    )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN jsonb_build_object('user_id', p_user_id, 'enqueued', v_count, 'enqueued_at', now());
END;
$function$;
