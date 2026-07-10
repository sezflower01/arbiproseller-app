
SELECT cron.schedule(
  'listing-validation-worker-1m',
  '* * * * *',
  $$
  SELECT net.http_post(
    url:='https://mstibdszibcheodvnprm.supabase.co/functions/v1/listing-validation-worker',
    headers:=jsonb_build_object('Content-Type','application/json','apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'),
    body:='{}'::jsonb,
    timeout_milliseconds:=300000
  );
  $$
);
