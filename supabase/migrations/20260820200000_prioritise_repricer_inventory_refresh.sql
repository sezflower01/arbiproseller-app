-- Refresh repricer-relevant inventory first.
--
-- inventory_refresh_queue already has a `priority` column and
-- dequeue_inventory_refresh already sorts by it:
--   ORDER BY q.priority ASC, q.created_at ASC
-- but nothing ever set it -- every row was enqueued at 100, so the queue was
-- pure FIFO.
--
-- Measured 2026-08-20: only 495 of 4,447 inventory rows (11%) back an enabled
-- repricer assignment. At 30 items/minute a full pass takes ~135 minutes, so the
-- ASINs that actually drive pricing decisions were refreshed at a random point
-- in a 2.2-hour cycle. Front-loading them clears all 495 in ~17 minutes:
-- roughly an 8x improvement in worst-case staleness for the rows that matter,
-- at zero extra API calls -- it is a sort order, not more work.
--
-- This matters because repricer-scheduler reads inventory.available/reserved at
-- evaluation time (SELECT ... FROM inventory WHERE user_id/asin/sku), so a stale
-- row feeds a real pricing decision.
--
-- MATCHED ON ASIN ONLY, deliberately, and it is not sloppiness:
--   * CA/MX/BR are REMOTE FULFILMENT -- they sell from the SAME physical US
--     stock. `inventory` has no marketplace column at all; one row serves all
--     four marketplaces. Verified 2026-08-20: 125/125 MX, 124/124 BR and 83/83
--     enabled assignments resolve to an inventory row on (asin, sku), and the
--     repricer's own lookup carries no marketplace filter.
--   * So an ASIN with an enabled assignment in ANY marketplace needs its single
--     inventory row fresh. Matching on (asin, sku) would be narrower -- 416 rows
--     rather than 495 -- and would drop rows whose ASIN is repriced under a
--     different SKU. The asin-only set is a strict superset, costs ~2.6 extra
--     minutes of queue time, and is robust to SKU mismatches.
--
-- Priorities are sparse (10/20/100) so tiers can be inserted later without
-- renumbering.

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
    SELECT
      i.user_id,
      i.asin,
      i.sku,
      'US'::text AS marketplace,   -- one physical pool; see header
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.repricer_assignments a
          WHERE a.user_id = i.user_id AND a.asin = i.asin
            AND a.is_enabled AND COALESCE(a.is_priority, false)
        ) THEN 10
        WHEN EXISTS (
          SELECT 1 FROM public.repricer_assignments a
          WHERE a.user_id = i.user_id AND a.asin = i.asin
            AND a.is_enabled
        ) THEN 20
        ELSE 100
      END AS priority
    FROM public.inventory i
    WHERE i.user_id = p_user_id
      AND i.asin IS NOT NULL
      AND i.sku IS NOT NULL
      AND COALESCE(i.source, '') <> 'created_listing'
      AND COALESCE(UPPER(i.listing_status), '') <> 'DELETED'
  ),
  ins AS (
    INSERT INTO public.inventory_refresh_queue (user_id, asin, sku, marketplace, status, priority)
    SELECT s.user_id, s.asin, s.sku, s.marketplace, 'pending', s.priority
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

-- Re-prioritise rows already queued, so the benefit lands on the current
-- backlog rather than waiting for the next 3-hourly enqueue. Only 'pending'
-- rows: a 'running' row is already claimed and reordering it achieves nothing.
UPDATE public.inventory_refresh_queue q
SET priority = 20
WHERE q.status = 'pending'
  AND q.priority <> 20
  AND EXISTS (
    SELECT 1 FROM public.repricer_assignments a
    WHERE a.user_id = q.user_id AND a.asin = q.asin
      AND a.is_enabled AND NOT COALESCE(a.is_priority, false)
  );

UPDATE public.inventory_refresh_queue q
SET priority = 10
WHERE q.status = 'pending'
  AND q.priority <> 10
  AND EXISTS (
    SELECT 1 FROM public.repricer_assignments a
    WHERE a.user_id = q.user_id AND a.asin = q.asin
      AND a.is_enabled AND COALESCE(a.is_priority, false)
  );

DO $$
DECLARE
  n_hi int; n_mid int; n_lo int;
BEGIN
  SELECT count(*) FILTER (WHERE priority = 10),
         count(*) FILTER (WHERE priority = 20),
         count(*) FILTER (WHERE priority = 100)
    INTO n_hi, n_mid, n_lo
  FROM public.inventory_refresh_queue WHERE status = 'pending';
  RAISE NOTICE 'pending queue after re-prioritisation: priority10=% priority20=% priority100=%',
    n_hi, n_mid, n_lo;
END $$;
