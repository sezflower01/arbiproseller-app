-- Scopes enqueue_full_inventory_refresh(uuid) to the US marketplace only.
--
-- Business reality confirmed with the user: CA/MX/BR are remote-fulfillment
-- extensions of the US catalog (no separate physical inventory shipped to
-- those countries) -- already a documented assumption elsewhere in this
-- codebase, see validate-marketplace-sellability/index.ts's sweep-mode
-- comment. But public.inventory has no marketplace column at all (one row
-- per user_id+sku), so refreshing CA/MX/BR was never able to track
-- anything separately -- it could only overwrite the same shared US-facing
-- row. Confirmed empirically this was actively happening: SKU
-- CE-2RDR-17A1 processed BR->US->MX->CA today, and its current
-- available/reserved/inbound came from CA (confirmed via exact
-- updated_at/processed_at timestamp correlation), not US. SKU 1065251490
-- similarly ended up sourced from BR (processed last), not US.
--
-- This cuts SP-API calls ~75% (1,858 -> ~471 rows per enqueue cycle for the
-- account tested) and eliminates the "last marketplace processed wins" race
-- at the source. See also the companion write-guard fix in
-- rescue-inventory-asin/index.ts for defense-in-depth against any other
-- caller ever enqueueing a non-US marketplace again.
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
     AND ra.marketplace = 'US'
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
