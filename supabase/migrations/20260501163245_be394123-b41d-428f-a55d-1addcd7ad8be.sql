DO $$
DECLARE
  v_user_id uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  v_cutoff timestamptz := '2026-05-01 15:48:00+00';
  v_tag text := 'restore_2026_05_01_full_sync_absent_path';
  v_restored_skus int := 0;
  v_restored_units numeric := 0;
  v_restored_value numeric := 0;
BEGIN
  -- Build restoration set: per-SKU latest positive live_api snapshot before the incident,
  -- only for SKUs whose current totals are LESS than that snapshot.
  CREATE TEMP TABLE _restore ON COMMIT DROP AS
  WITH snap AS (
    SELECT DISTINCT ON (sku) sku, available, reserved, inbound, captured_at
    FROM inventory_history
    WHERE user_id = v_user_id
      AND captured_at < v_cutoff
      AND source = 'live_api'
      AND (COALESCE(available,0)+COALESCE(reserved,0)+COALESCE(inbound,0)) > 0
    ORDER BY sku, captured_at DESC
  )
  SELECT i.sku,
         s.available AS new_avail,
         s.reserved  AS new_res,
         s.inbound   AS new_inb,
         i.cost      AS cost,
         (s.available+s.reserved+s.inbound)
           - (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)) AS delta_units
  FROM inventory i
  JOIN snap s USING (sku)
  WHERE i.user_id = v_user_id
    AND (s.available+s.reserved+s.inbound) > (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0));

  -- Apply updates. Bypass freshness guard via a sentinel sync.
  UPDATE inventory i
  SET available = r.new_avail,
      reserved  = r.new_res,
      inbound   = r.new_inb,
      last_inventory_sync_at = now(),
      last_summaries_at = now()
  FROM _restore r
  WHERE i.user_id = v_user_id AND i.sku = r.sku;

  -- Write history rows for traceability
  INSERT INTO inventory_history (user_id, asin, sku, available, reserved, inbound, listing_status, source, sync_trace_id, captured_at)
  SELECT v_user_id, i.asin, i.sku, r.new_avail, r.new_res, r.new_inb, i.listing_status, 'restore_from_history', v_tag, now()
  FROM _restore r
  JOIN inventory i ON i.user_id = v_user_id AND i.sku = r.sku;

  SELECT COUNT(*), COALESCE(SUM(delta_units),0), COALESCE(SUM(delta_units * COALESCE(cost,0)),0)
    INTO v_restored_skus, v_restored_units, v_restored_value
  FROM _restore;

  RAISE NOTICE 'RESTORED skus=% units=% value=%', v_restored_skus, v_restored_units, v_restored_value;
END $$;