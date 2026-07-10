SELECT cron.unschedule('catchup-fba-shipments-weekly');

SELECT cron.schedule(
  'catchup-fba-shipments-weekly',
  '0 6 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/catchup-fba-shipments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
      'x-internal-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1), '')
    ),
    body := jsonb_build_object('triggered_by', 'cron', 'time', now()::text),
    timeout_milliseconds := 300000
  );
  $$
);

-- Kick off a catch-up run right now so the ~2 months of missed shipments (May, June, early July 2026)
-- start filling in without waiting for next Monday.
SELECT net.http_post(
  url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/catchup-fba-shipments',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
    'x-internal-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1), '')
  ),
  body := jsonb_build_object('triggered_by', 'manual_backfill', 'time', now()::text),
  timeout_milliseconds := 300000
);