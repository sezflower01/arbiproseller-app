-- Unschedule any prior instance, then (re)create
DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'repricer-classify-strategy-hourly';
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END$$;

SELECT cron.schedule(
  'repricer-classify-strategy-hourly',
  '7 * * * *',
  $$
  SELECT net.http_post(
    url:='https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-classify-strategy',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body:=jsonb_build_object('time', now()),
    timeout_milliseconds:= 300000
  );
  $$
);