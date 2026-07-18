-- Two related changes to the hourly inventory-refresh enqueue, per user request:
--
-- 1. Widen scope: enqueue_full_inventory_refresh(uuid) previously required a
--    matching ENABLED repricer_assignments row (marketplace='US') to include
--    a SKU at all -- confirmed live this excludes the majority of a large
--    catalog (e.g. 3,800 of 4,416 inventory rows for the account tested had
--    no enabled US assignment). A SKU that's been dormant/disabled for a long
--    time and gets freshly replenished would never get its stock re-checked
--    by this pipeline, since disabled assignments are excluded outright.
--    inventory has no marketplace column (one row per user_id+sku) and is
--    already treated elsewhere as the US-sourced catalog (see
--    20260712203719_scope_inventory_refresh_enqueue_to_us_only.sql), so the
--    join to repricer_assignments only ever existed to gate on is_enabled --
--    dropping it and reading straight from inventory covers every US SKU
--    regardless of assignment/enabled status, while keeping the same
--    data-quality filters (asin/sku present, not a created_listing draft,
--    not DELETED).
--
-- 2. Slow the cadence from hourly to every 3 hours. Verified throughput is a
--    sustained 30 SKUs/minute (observed live), so a full pass now covers
--    ~5,400 SKUs within one 3-hour window (180min * 30/min) with margin --
--    comfortably ahead of the current 4,416-row catalog and the 5,000-SKU
--    case discussed with the user. Widening scope alone would have made the
--    hourly cadence enqueue overlapping/duplicate-blocked batches long before
--    a full sweep finished; every-3-hours gives the worker room to actually
--    drain what gets queued.
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
    SELECT i.user_id, i.asin, i.sku, 'US'::text AS marketplace
    FROM public.inventory i
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

SELECT cron.unschedule('full-inventory-refresh-2h');

SELECT cron.schedule(
  'full-inventory-refresh-2h',
  '15 */3 * * *',
  $$ SELECT public.enqueue_full_inventory_refresh_all_users(); $$
);
