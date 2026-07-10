SELECT cron.unschedule('full-inventory-refresh-2h');

SELECT cron.schedule(
  'full-inventory-refresh-2h',
  '15 */2 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-inventory-report-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-2h-reports', 'time', now()::text),
    timeout_milliseconds := 300000
  );
  $cron$
);