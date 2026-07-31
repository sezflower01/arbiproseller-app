-- Safety net for full_inventory_refresh_runs, mirroring
-- 20260731030000_schedule_fnsku_sync_timeout_sweep.sql.
SELECT cron.schedule(
  'full-inv-refresh-timeout-sweep-15m',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/full-inv-refresh-timeout-sweep',
    headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text) FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
