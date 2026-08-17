-- Restrict seller monitoring to overnight, so it stops competing with the
-- extension panel for Keepa tokens during the working day.
--
-- WHY: check-seller-watchlist spends a flat 10 tokens per seller against a
-- 5 tokens/min plan, and mobile-scan-price-history (every panel product view,
-- offers=100) is UNGATED -- it takes what it needs without asking. Observed
-- 2026-08-17: tokens_left fell from 66 to 5 of 300 inside eleven minutes while
-- the panel was in use, and the panel degraded to Amazon-only price history.
--
-- ⚠️ pg_cron evaluates schedules in UTC. Putting "0-5" in the hour field would
-- have run this 5pm-11pm Pacific -- peak usage, the exact opposite of the
-- intent. Worse, a fixed UTC range drifts an hour twice a year with DST.
--
-- So the schedule stays every-5-minutes and the window is enforced in the
-- COMMAND, against America/Los_Angeles. Postgres resolves that zone with its
-- own DST rules, so the window stays midnight-6am local year-round with no
-- seasonal edit. `SELECT f() WHERE false` never evaluates f(), so outside the
-- window this costs one cheap clock comparison and makes no HTTP call.
--
-- auto-source-new-listings is deliberately NOT windowed: it is CSE/Gemini
-- bound and only touches Keepa in find-source-candidates' backfill fallback,
-- so restricting it would cost search throughput for almost no token relief.
--
-- TRADEOFF, stated plainly: seller rotation goes from roughly 13 hours to
-- roughly 1.9 days for ~402 sellers (about 2,100 tokens available per
-- overnight window against 7,200 per full day, at 10 tokens per seller).
-- New-listing detection lag becomes 1-2 days. Accepted deliberately -- sellers
-- take days to ship into FBA, so same-day detection was never the point.

DO $$
BEGIN
  PERFORM cron.unschedule('check-seller-watchlist-5min');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'check-seller-watchlist-5min not scheduled, nothing to unschedule';
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('check-seller-watchlist-hourly');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'check-seller-watchlist-hourly not scheduled, nothing to unschedule';
END $$;

SELECT cron.schedule(
  'check-seller-watchlist-5min',
  '2-57/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-seller-watchlist',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-seller-watchlist-5min', 'time', now()::text),
    timeout_milliseconds := 120000
  )
  WHERE EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Los_Angeles')) < 6;
  $cron$
);

-- The hourly job is the catch-up sweep; same window, same reasoning.
SELECT cron.schedule(
  'check-seller-watchlist-hourly',
  '15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-seller-watchlist',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-seller-watchlist-hourly', 'time', now()::text),
    timeout_milliseconds := 120000
  )
  WHERE EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Los_Angeles')) < 6;
  $cron$
);
