-- Remove any prior schedule with the same name (idempotent re-run safety)
DO $$
BEGIN
  PERFORM cron.unschedule('auto-sync-settlements-weekly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Schedule weekly settlement auto-sync: every Monday at 09:00 UTC
SELECT cron.schedule(
  'auto-sync-settlements-weekly',
  '0 9 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/auto-sync-settlements-weekly',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"}'::jsonb,
    body := jsonb_build_object('triggeredBy', 'pg_cron', 'time', now())
  ) AS request_id;
  $$
);