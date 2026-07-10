DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'poll-fbm-label-costs-30min') THEN
    PERFORM cron.unschedule('poll-fbm-label-costs-30min');
  END IF;
END $$;

SELECT cron.schedule(
  'poll-fbm-label-costs-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/poll-fbm-label-costs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('triggered_by', 'cron'),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);