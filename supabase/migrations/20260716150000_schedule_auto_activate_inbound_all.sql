-- auto-activate-inbound-all (loops US/CA/MX/BR, calls auto-assign-bulk per
-- marketplace) was fully built — cron-lock, audit table, staggered calls —
-- but was never actually scheduled anywhere. The only other callers of
-- auto-assign-bulk (sync-amazon-inventory, sync-inventory-report, both
-- triggered every 2h via full-inventory-refresh-2h) are hardcoded to
-- marketplace='US' only. Result: US repricer assignments get a fresh
-- backfill/retry pass every 2 hours; CA/MX/BR assignments get exactly ONE
-- activation attempt ever, at onboarding time, and never again — so any
-- one-time gap (e.g. cost not yet synced into inventory at that exact
-- moment) becomes permanent for international marketplaces, even after
-- the underlying cost data is fixed. This is the concrete cause behind
-- stale "1 fail" / activation_needs_cost assignments that turned out to
-- have valid cost all along (confirmed against real account data:
-- 104 of 132 flagged rows were CA/MX/BR with valid created_listings cost
-- and null bounds, never retried).
--
-- Same offset pattern as full-inventory-refresh-2h (:15) — staggered to
-- :45 so the two 2-hourly crons don't fire in the same minute.
SELECT cron.schedule(
  'auto-activate-inbound-all-2h',
  '45 */2 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/auto-activate-inbound-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-2h-auto-activate', 'time', now()::text),
    timeout_milliseconds := 300000
  );
  $cron$
);
