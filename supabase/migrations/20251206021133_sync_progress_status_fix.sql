UPDATE pl_sync_progress 
SET status = 'completed', 
    message = 'Completed with partial data - Period 1/2, page 254',
    updated_at = now()
WHERE id = '9d15870d-aac5-46b9-bda9-c7d4ca4df7bd' AND status = 'running'