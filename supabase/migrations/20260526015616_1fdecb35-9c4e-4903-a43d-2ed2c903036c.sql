UPDATE public.sales_sync_state
SET last_events_sync_at = (now() - INTERVAL '24 hours')
WHERE last_events_sync_at < (now() - INTERVAL '24 hours');