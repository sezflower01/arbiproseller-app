-- Grace-period capacity policy: never block repricer activation on capacity
-- in real time (see auto-onboard-asin change in the same deploy). Instead,
-- reconcile each account's listing count vs. plan only at ITS OWN billing
-- renewal, auto-upgrading to the smallest covering tier if still >110% over
-- at that moment. Runs hourly so it catches renewals promptly regardless of
-- what time of day/month a given customer's billing cycle lands on.

DO $$
BEGIN
  PERFORM cron.unschedule('repricer-billing-cycle-check-hourly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repricer-billing-cycle-check-hourly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'repricer-billing-cycle-check-hourly',
  '15 * * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-billing-cycle-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
      'x-internal-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1), '')
    ),
    body := jsonb_build_object('triggered_by', 'cron-hourly', 'time', now()::text),
    timeout_milliseconds := 120000
  ) AS request_id;
  $cmd$
);
