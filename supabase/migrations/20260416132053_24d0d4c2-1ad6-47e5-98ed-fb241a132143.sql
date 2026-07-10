
UPDATE historical_sync_checkpoints 
SET status = 'done', 
    completed_at = now(), 
    updated_at = now()
WHERE sync_type = 'settled' 
  AND status = 'running'
  AND EXISTS (
    SELECT 1 FROM financial_events_cache fec 
    WHERE fec.user_id = historical_sync_checkpoints.user_id
    AND fec.event_date >= (historical_sync_checkpoints.month_key || '-01')::date
    AND fec.event_date < ((historical_sync_checkpoints.month_key || '-01')::date + interval '1 month')
  );
