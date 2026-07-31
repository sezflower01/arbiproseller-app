SELECT cron.schedule(
  'repricer-feed-verify-sweep-2m',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-feed-verify-sweep',
    headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text) FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
