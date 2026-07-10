-- Disable broken 4h cron (was hitting per-user cap and freshness skip)
SELECT cron.unschedule('auto-inventory-sync-4h');

-- New 2h full-refresh cron mirrors the Manual SP-API Refresh button: no per-user cap, no freshness skip
SELECT cron.schedule(
  'full-inventory-refresh-2h',
  '15 */2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/full-inventory-refresh-all',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1), '')
    ),
    body := jsonb_build_object('triggered_by', 'cron-2h', 'time', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);