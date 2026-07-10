-- Push marker back to 36 hours ago to trigger the 48h stale-marker replay
-- This will cause the next unified_sync to detect markerAge > 12h and replay
-- the full 48h window, covering all of April 7
UPDATE public.sales_sync_state
SET last_orders_sync_at = (now() - interval '36 hours'),
    updated_at = now()
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9';