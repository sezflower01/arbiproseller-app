-- =====================================================================
-- PART 1: RESTORE CRITICAL PAUSED JOBS
-- PART 2: STAGGER 4 PER-MINUTE REPRICER JOBS (3x CPU reduction)
-- =====================================================================

-- --------- helper: unschedule by id if name exists --------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname IN (
      'full-inventory-refresh-2h',
      'sync-inventory-report-4h',
      'sync-fbm-cleanup-4h',
      'listing-validation-worker-1m',
      'health-alerts-15min',
      'repricer-sequential-sweep',
      'repricer-unified-dispatch',
      'repricer-unified-dispatch-worker-b'
    )
  LOOP
    BEGIN
      PERFORM cron.unschedule(r.jobid);
      RAISE NOTICE 'unscheduled % (id %)', r.jobname, r.jobid;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'could not unschedule % (id %): %', r.jobname, r.jobid, SQLERRM;
    END;
  END LOOP;
END $$;

-- ==================== PART 1: restore critical ========================

-- 1. full-inventory-refresh-2h (uses queue enqueue, not direct http_post)
SELECT cron.schedule(
  'full-inventory-refresh-2h',
  '15 */2 * * *',
  $$ SELECT public.enqueue_full_inventory_refresh_all_users(); $$
);

-- 2. sync-inventory-report-4h (fan-out wrapper)
SELECT cron.schedule(
  'sync-inventory-report-4h',
  '0 */4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-inventory-report-all',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('triggered_by','cron-4h','time', now()::text)::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- 3. sync-fbm-cleanup-4h
SELECT cron.schedule(
  'sync-fbm-cleanup-4h',
  '45 */4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-fbm-cleanup-all',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('triggered_by', 'cron-sync-fbm-cleanup-4h')::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- 4. listing-validation-worker-1m
SELECT cron.schedule(
  'listing-validation-worker-1m',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/listing-validation-worker',
    headers := jsonb_build_object('Content-Type','application/json','apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- 5. health-alerts-15min (internal SQL function)
SELECT cron.schedule(
  'health-alerts-15min',
  '*/15 * * * *',
  $$ SELECT public.evaluate_health_alerts(); $$
);

-- ==================== PART 2: stagger repricer ========================
-- Was: all four jobs at '* * * * *' (every minute, simultaneously)
-- Now: auto-turbo every minute (cheap primary tick), the 3 heavies on 3-min cycle
--      offset by 1 minute each, so only ONE heavy fires per minute and never overlap.

-- repricer-sequential-sweep -> every 3 min starting :00
SELECT cron.schedule(
  'repricer-sequential-sweep',
  '0-59/3 * * * *',
  $$
  SELECT net.http_post(
    url:='https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-sequential-sweep',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"}'::jsonb,
    body:=concat('{"time": "', now(), '"}')::jsonb
  ) AS request_id;
  $$
);

-- repricer-unified-dispatch -> every 3 min starting :01
SELECT cron.schedule(
  'repricer-unified-dispatch',
  '1-59/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-unified-dispatch',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"}'::jsonb,
    body := '{"scheduled": true}'::jsonb
  ) AS request_id;
  $$
);

-- repricer-unified-dispatch-worker-b -> every 3 min starting :02
SELECT cron.schedule(
  'repricer-unified-dispatch-worker-b',
  '2-59/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-unified-dispatch',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"}'::jsonb,
    body := '{"scheduled": true, "worker_shard": "B"}'::jsonb
  ) AS request_id;
  $$
);