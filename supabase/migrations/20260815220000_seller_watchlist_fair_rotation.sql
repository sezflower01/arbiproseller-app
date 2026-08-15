-- Seller watchlist: fair rotation + resumable queue.
--
-- The hourly worker had three defects that together produced silent,
-- PERMANENT starvation rather than mere slowness:
--
--   1. `.limit(500)` was global across all users -- past 500 active watches
--      the overflow was never read from the database at all.
--   2. No ORDER BY, so whichever rows Postgres happened to return first won
--      the rate-limit slot on every run, forever. last_checked_at was
--      written but never read.
--   3. On a busy gate the worker skipped onward and kept no memory of who
--      was passed over, so the next run repeated the same choice.
--
-- The UI showed every watch as "Watching" regardless, so users could not
-- distinguish "checked, nothing new" from "never checked at all".
--
-- The worker now orders by last_checked_at ASC NULLS FIRST and stops when
-- budget or time runs out, resuming next run. This migration provides the
-- index that ordering needs, and shortens the cron so the queue advances in
-- small, frequent increments instead of one burst per hour.

-- Partial index matching the worker's exact query shape (active only,
-- ordered by staleness). NULLS FIRST is the default for ASC in Postgres
-- only for DESC ordering, so the index spells the ordering out explicitly to
-- guarantee it can serve the query without a sort.
CREATE INDEX IF NOT EXISTS idx_seller_watchlist_rotation
  ON public.seller_watchlist (last_checked_at ASC NULLS FIRST)
  WHERE status = 'active';

-- Re-schedule: hourly -> every 5 minutes.
--
-- A 10-token /seller call against a 5-tokens/min plan means roughly one
-- check every two minutes at full budget, so an hourly burst was the wrong
-- shape: it could only ever spend a fraction of the hour's refill before the
-- run ended, and the rest of the budget evaporated. Every 5 minutes lets the
-- queue draw down the bucket steadily as it refills.
--
-- Keeps the :x5 offset away from check-price-alerts-hourly at :00 so the two
-- Keepa-consuming jobs do not collide on the hour.
DO $$
BEGIN
  PERFORM cron.unschedule('check-seller-watchlist-hourly');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'check-seller-watchlist-hourly not scheduled, nothing to unschedule';
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('check-seller-watchlist-5min');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'check-seller-watchlist-5min not scheduled, nothing to unschedule';
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
  );
  $cron$
);
