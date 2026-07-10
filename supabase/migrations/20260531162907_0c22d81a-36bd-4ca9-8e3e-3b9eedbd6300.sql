CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;

DO $$
DECLARE
  j text;
  pause_jobs text[] := ARRAY[
    'auto-sync-sales-every-10-minutes',
    'repair-pending-prices-every-15-min',
    'backfill-fee-cache-every-15min',
    'enrich-pending-orders-every-15-min',
    'monitor-snapshot-5min',
    'drain-bounds-sync-every-minute',
    'monitor-spapi-health-15min',
    'full-inventory-refresh-2h',
    'sync-inventory-report-4h',
    'sync-fbm-cleanup-4h',
    'listing-validation-worker-1m',
    'health-alerts-15min',
    'repricer-cleanup-cron',
    'repricer-classify-strategy-hourly',
    'repricer-executive-summary-daily',
    'repricer-opportunity-score-hourly',
    'nightly-parity-check',
    'nightly-ghost-cleanup-0430',
    'clean-ghost-listings-12h',
    'cleanup-dead-assignments-6h',
    'nightly-data-cleanup-0330',
    'nightly-vacuum-analyze-0345',
    'capture-db-size-snapshot-hourly',
    'inventory-refresh-queue-cleanup-daily'
  ];
BEGIN
  FOREACH j IN ARRAY pause_jobs LOOP
    BEGIN
      PERFORM cron.unschedule(j);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skip pause %: %', j, SQLERRM;
    END;
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT jobname, command
    FROM cron.job
    WHERE jobname IN (
      'invoke-repricer-auto-turbo',
      'repricer-sequential-sweep',
      'repricer-unified-dispatch',
      'repricer-unified-dispatch-worker-b'
    )
  LOOP
    BEGIN
      PERFORM cron.unschedule(r.jobname);
      PERFORM cron.schedule(r.jobname, '*/5 * * * *', r.command);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skip slow %: %', r.jobname, SQLERRM;
    END;
  END LOOP;
END $$;

DO $$
DECLARE
  v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'inventory-refresh-worker-1m';
  IF v_cmd IS NOT NULL THEN
    v_cmd := regexp_replace(v_cmd, '''batch_size'', 25', '''batch_size'', 5', 'g');
    PERFORM cron.unschedule('inventory-refresh-worker-1m');
    PERFORM cron.schedule('inventory-refresh-worker-1m', '*/5 * * * *', v_cmd);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skip slow inventory-refresh-worker-1m: %', SQLERRM;
END $$;