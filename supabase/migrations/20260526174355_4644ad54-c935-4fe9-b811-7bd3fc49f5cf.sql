UPDATE public.user_sync_status uss
SET history_syncing = false,
    history_complete = true,
    pl_ready = true,
    updated_at = now()
WHERE uss.history_syncing = true
  AND NOT EXISTS (
    SELECT 1 FROM public.historical_sync_checkpoints c
    WHERE c.user_id = uss.user_id
      AND c.sync_type = 'settled'
      AND c.status IN ('running','queued','error','partial')
  )
  AND EXISTS (
    SELECT 1 FROM public.historical_sync_checkpoints c2
    WHERE c2.user_id = uss.user_id
      AND c2.sync_type = 'settled'
      AND c2.status = 'done'
  );