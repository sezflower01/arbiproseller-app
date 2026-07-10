
-- Schedule worker to drain queue every minute
SELECT cron.schedule(
  'inventory-refresh-worker-1m',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/inventory-refresh-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('batch_size', 25),
    timeout_milliseconds := 90000
  );
  $cron$
);

-- Daily cleanup of old success rows (3am UTC)
SELECT cron.schedule(
  'inventory-refresh-queue-cleanup-daily',
  '0 3 * * *',
  $cron$ SELECT public.cleanup_inventory_refresh_queue(); $cron$
);
