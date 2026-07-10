-- Reset stuck historical sync for user
UPDATE public.sales_sync_state 
SET historical_sync_in_progress = false, 
    historical_sync_progress = NULL,
    historical_sync_started_at = NULL,
    backfill_complete = true,
    updated_at = now()
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9';