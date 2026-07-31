-- The sweep now also RESUMES moderately-stale in_progress runs (not just
-- marks very-stale ones as timed_out) -- see full-inv-refresh-timeout-sweep.
-- That only helps if it runs often enough to matter, so tighten the cadence
-- from every 15 minutes to every 1 minute.
SELECT cron.unschedule('full-inv-refresh-timeout-sweep-15m');

SELECT cron.schedule(
  'full-inv-refresh-timeout-sweep-1m',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/full-inv-refresh-timeout-sweep',
    headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text) FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
