-- FBM listings only get fresh quantity data from the 4-hourly
-- GET_MERCHANT_LISTINGS_ALL_DATA report sync (sync-fbm-cleanup-4h) — that
-- report is a heavy whole-catalog async job, so re-running it every few
-- minutes isn't practical. Instead, fbm-quick-check-all does a cheap,
-- targeted live check: only for FBM listings we already believe are at zero
-- stock, via a lightweight per-SKU Listings API call. This closes the gap
-- where a seller adds units to a previously-out-of-stock FBM listing in
-- Seller Central and would otherwise wait up to 4 hours to see it picked up
-- by the repricer.
SELECT cron.schedule(
  'fbm-quick-check-5min',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fbm-quick-check-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-5min-fbm-quick-check', 'time', now()::text),
    timeout_milliseconds := 280000
  );
  $cron$
);
