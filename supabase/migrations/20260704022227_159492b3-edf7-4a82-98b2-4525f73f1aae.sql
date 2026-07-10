-- The wrapper function catchup-fba-shipments hit WORKER_RESOURCE_LIMIT trying to
-- pull per-shipment items across a 13-month window for every user in one go.
-- The UI's own "Sync Missing (18mo)" button avoids that by calling
-- sync-fba-shipments directly with { lookbackDays: 540, headersOnly: true }.
-- Point the weekly cron at that same lightweight path (headers only; items are
-- filled on demand when a shipment row is opened, and by the regular hourly sync).

SELECT cron.unschedule('catchup-fba-shipments-weekly');

SELECT cron.schedule(
  'catchup-fba-shipments-weekly',
  '0 6 * * 1',
  $$
  WITH users AS (
    SELECT DISTINCT user_id FROM public.seller_authorizations WHERE user_id IS NOT NULL
  )
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-fba-shipments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
      'x-internal-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object(
      'user_id', users.user_id,
      'lookbackDays', 540,
      'headersOnly', true
    ),
    timeout_milliseconds := 300000
  ) AS request_id
  FROM users;
  $$
);