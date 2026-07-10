-- Restore 48 SKUs that were incorrectly zeroed by sync-inventory-report on 2026-05-01
-- between 15:48 and 16:30 UTC. Source values from inventory_history (last positive snapshot
-- before the bad sync). Only restores rows still at 0/0/0 with source='live_api'.

WITH last_positive AS (
  SELECT DISTINCT ON (h.user_id, h.sku)
    h.user_id, h.sku, h.available, h.reserved, h.inbound, h.captured_at
  FROM public.inventory_history h
  WHERE h.captured_at < '2026-05-01 15:48:00+00'
    AND (h.available + h.reserved + h.inbound) > 0
  ORDER BY h.user_id, h.sku, h.captured_at DESC
),
targets AS (
  SELECT i.id, lp.available, lp.reserved, lp.inbound
  FROM public.inventory i
  JOIN last_positive lp
    ON lp.user_id = i.user_id AND lp.sku = i.sku
  WHERE i.source = 'live_api'
    AND i.available = 0 AND i.reserved = 0 AND i.inbound = 0
    AND i.last_inventory_sync_at BETWEEN '2026-05-01 15:48:00+00' AND '2026-05-01 16:30:00+00'
)
UPDATE public.inventory i
SET available = t.available,
    reserved  = t.reserved,
    inbound   = t.inbound,
    listing_status = CASE WHEN (t.available + t.reserved + t.inbound) > 0 THEN 'ACTIVE' ELSE i.listing_status END,
    source = 'live_api',
    last_inventory_sync_at = now(),
    updated_at = now()
FROM targets t
WHERE i.id = t.id;

-- Snapshot the restored values into history for traceability
INSERT INTO public.inventory_history (user_id, asin, sku, available, reserved, inbound, listing_status, source, sync_trace_id, captured_at)
SELECT i.user_id, i.asin, i.sku, i.available, i.reserved, i.inbound, i.listing_status, 'restore_from_history', 'restore_2026_05_01_suspicious_zero', now()
FROM public.inventory i
WHERE i.last_inventory_sync_at > now() - interval '1 minute'
  AND i.source = 'live_api'
  AND (i.available + i.reserved + i.inbound) > 0;