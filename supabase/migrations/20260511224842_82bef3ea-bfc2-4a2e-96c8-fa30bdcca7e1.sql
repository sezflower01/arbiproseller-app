
-- Lower default retentions only if still at the prior default (avoid clobbering admin overrides)
UPDATE public.database_maintenance_settings
   SET retention_days = 3, updated_at = now()
 WHERE table_key = 'pg_cron_history' AND retention_days = 7;

UPDATE public.database_maintenance_settings
   SET retention_days = 14, updated_at = now()
 WHERE table_key = 'repricer_price_actions' AND retention_days = 30;

-- Replace broken repricer-cleanup-cron (job 15) with named-arg net.http_post
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'repricer-cleanup-cron';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule(
  'repricer-cleanup-cron',
  '0 */2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-cleanup',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"}'::jsonb,
    body := '{"scheduled": true}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

-- Hourly DB size snapshot for growth tracking
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'capture-db-size-snapshot-hourly';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule(
  'capture-db-size-snapshot-hourly',
  '7 * * * *',
  $$ SELECT public.capture_database_size_snapshot(); $$
);

-- Capture an initial snapshot immediately so the growth card has a baseline
SELECT public.capture_database_size_snapshot();
