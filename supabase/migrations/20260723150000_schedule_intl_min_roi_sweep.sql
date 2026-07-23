-- International Min ROI Enforcement ("Apply now" on the Settings tab) only
-- ever ran when someone manually clicked the button. The continuous repricer
-- evaluation cycle enforces whatever min_price_override is already stored,
-- but never recomputes that floor itself using live SP-API fees + FX -- so a
-- CA/MX/BR floor set months ago just keeps getting enforced as-is, silently
-- going stale as fees and exchange rates drift.
--
-- Scheduled daily at 07:00 UTC, one hour after refresh-fx-rates-daily (06:00,
-- see 20260719000000_schedule_daily_fx_rate_refresh.sql) so the sweep always
-- runs against same-day FX rates. Same x-internal-secret vault-secret cron
-- pattern as the other internal jobs.
SELECT cron.schedule(
  'apply-min-roi-intl-sweep-daily',
  '0 7 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/apply-min-roi-intl-sweep-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-daily-intl-roi-sweep', 'time', now()::text),
    timeout_milliseconds := 300000
  );
  $cron$
);
