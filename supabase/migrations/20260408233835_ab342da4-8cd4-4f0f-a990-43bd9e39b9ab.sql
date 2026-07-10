-- Advance the stuck sync marker so the next successful sync
-- will replay orders from 6 hours ago instead of being stuck on April 7.
-- This is a one-time repair for the stuck cursor.
UPDATE public.sales_sync_state
SET last_orders_sync_at = (now() - interval '6 hours'),
    updated_at = now()
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND last_orders_sync_at < (now() - interval '24 hours');