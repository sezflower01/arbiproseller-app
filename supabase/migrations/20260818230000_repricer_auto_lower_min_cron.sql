-- Schedule repricer-auto-lower-min: the hourly floor-drop worker.
--
-- ⚠️ APPLY THIS LAST. Committing the edge function to main auto-deploys it via
-- .github/workflows/deploy-edge-functions.yml, but migrations are NOT auto-
-- applied. Until `npm run db:push` runs this file, the function ships dormant
-- and cannot touch a price. That ordering is deliberate: it lets a dry run be
-- reviewed against real data before anything is scheduled.
--
-- WHAT IT DOES
-- Lowers `min_price_override` on assignments whose repricer is blocked by the
-- seller's own floor. It writes ONLY that column — no Amazon call, no SP-API,
-- no Keepa. repricer-scheduler already runs 24/7 and picks the new floor up on
-- its next pass, so this job consumes no metered quota and cannot starve the
-- shared rate gates.
--
-- TIMING
-- :40 past the hour. check-price-alerts holds :00 and check-seller-watchlist
-- holds :15, so this does not burst alongside either — the staggering rule in
-- CLAUDE.md.
--
-- SCOPE ON FIRST ENABLE
-- marketplaces = ["US"] only. MX/CA/BR stay off until a few US runs have been
-- reviewed in cron_run_history. Widen by editing the body below and re-running
-- cron.schedule with the same job name (it upserts).
--
-- AUTH
-- pg_cron sends x-internal-secret and NO Authorization header. The function is
-- registered verify_jwt = false in supabase/config.toml for exactly that reason;
-- without it the gateway rejects the call before the function runs, producing no
-- function log at all. Diagnose by shape: {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}
-- is the platform, {"error":"Forbidden"} is the function's own guard.

SELECT cron.unschedule('repricer-auto-lower-min-hourly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'repricer-auto-lower-min-hourly'
);

SELECT cron.schedule(
  'repricer-auto-lower-min-hourly',
  '40 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-auto-lower-min',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object(
      'triggered_by', 'cron-auto-lower-min-hourly',
      'marketplaces', jsonb_build_array('US'),
      'time', now()::text
    ),
    timeout_milliseconds := 120000
  );
  $cron$
);
