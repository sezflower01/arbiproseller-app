-- Marks fnsku_sync_history rows stuck 'in_progress' with no recent
-- heartbeat as 'timed_out' -- see fnsku-sync-timeout-sweep for full context
-- (759 historical rows never got any terminal status before this).
-- Uses the x-internal-secret + vault.decrypted_secrets pattern confirmed
-- working in 20260728184500_auto_detect_primary_marketplace.sql.
SELECT cron.schedule(
  'fnsku-sync-timeout-sweep-15m',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fnsku-sync-timeout-sweep',
    headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text) FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
