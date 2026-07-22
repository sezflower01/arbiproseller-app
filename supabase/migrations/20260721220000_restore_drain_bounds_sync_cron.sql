-- Restore drain-bounds-sync-every-minute, paused on 2026-05-31 during an
-- emergency DB-load reduction (migration 20260531162907) and never
-- re-enabled (unlike listing-validation-worker-1m and others, which were
-- restored 8 minutes later in migration 20260531171107). This left every
-- user's min/max price bounds sync to Amazon fully manual -- the only way
-- pending/failed bounds ever reached Amazon was an admin clicking
-- "Push Bounds to Amazon" by hand. Confirmed live: 951 assignments stuck
-- with no sync attempt since 2026-04-12.

DO $$
BEGIN
  PERFORM cron.unschedule('drain-bounds-sync-every-minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'drain-bounds-sync-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/drain-bounds-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);
