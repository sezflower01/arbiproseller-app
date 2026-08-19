-- Remove the overnight-only window: seller monitoring runs 24/7 again.
--
-- The window (migration 20260817140000) was NEVER about token capacity. It was
-- added because mobile-scan-price-history was ungated and the sweep was
-- starving it -- tokens fell 66 -> 5 of 300 in eleven minutes while the
-- extension panel was in use. Keeping the sweep out of working hours was a
-- blunt fix for a contention problem.
--
-- BOTH causes are now addressed, and verified rather than assumed:
--
--   1. CONTENTION. mobile-scan-price-history moved to the TOKEN-ONLY lane
--      (acquireKeepaTokensOnly), so it claims no Layer 1 call slot and cannot
--      queue behind the sweep's bursts. Layer 1 is 4 -> 20 calls/min and needs
--      ~3,015/day against 28,800 available, so it is not binding either.
--
--   2. CAPACITY. A Keepa API Access subscription was added 2026-08-19. Live
--      verification against Keepa's OWN response, not our stored value:
--        refillRate        25   (20 purchased + 5 Keepa Pro base)
--        tokensLeft      1499   of a 1500 bucket
--        tokensConsumed     1   for a /product stats=1 call
--        tokenFlowReduction 0   no penalty despite today's overdrafts
--      Our accounting agreed at 25/min and read 1494 -- 5 LOW, the safe
--      direction. The failure this morning was the opposite sign: we read 38.1
--      while Keepa read -9.
--
-- CAPACITY MATH: 25/min = 36,000 tokens/day. A full rotation of ~402 sellers
-- costs 402 x 10 = 4,020. After other consumers (check-price-alerts ~4,800/day,
-- interactive analyzer ~1,000, price capture ~60) roughly 30,100 remain, giving
-- ~7.5 rotations/day -- a full pass every ~3.2 hours, against ~1.9 DAYS under
-- the overnight window.
--
-- Note the window was never the capacity limiter it looked like: it capped the
-- sweep at ~2,100 tokens/night. The upgrade plus the token-only lane are what
-- make 24/7 safe; removing the window is just collecting the benefit.
--
-- TO RESTORE the window, re-add to BOTH commands below:
--   WHERE EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Los_Angeles')) < 6;
-- pg_cron evaluates schedules in UTC, which is why the window lived in the
-- COMMAND against an explicit zone rather than in the hour field -- "0-5" there
-- would have run it 5pm-11pm Pacific, the exact opposite of the intent.

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
  );
  $cron$
);
