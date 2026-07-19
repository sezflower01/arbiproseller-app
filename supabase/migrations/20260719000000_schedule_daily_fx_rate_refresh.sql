-- refresh-fx-rates (fetches CAD/MXN/BRL from Frankfurter.app, falls back to
-- exchangerate.host) existed but was never scheduled — it only ran when a
-- user manually clicked "Refresh" on the Target ROI Price tool. Confirmed
-- live the stored rates were last refreshed 2026-01-12, over 6 months stale,
-- and every USD conversion in the app (fee display, ROI, revenue) reads
-- straight from this table. Scheduling a daily refresh so it can't silently
-- go stale again. Same x-internal-secret vault-secret pattern as the other
-- internal cron jobs (see 20260716150000_schedule_auto_activate_inbound_all.sql).
SELECT cron.schedule(
  'refresh-fx-rates-daily',
  '0 6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/refresh-fx-rates',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-daily-fx-refresh', 'time', now()::text),
    timeout_milliseconds := 60000
  );
  $cron$
);
