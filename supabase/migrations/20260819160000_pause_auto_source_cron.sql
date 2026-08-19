-- PAUSE the auto-source search worker. TEMPORARY — restore instructions below.
--
-- WHY: Find Source cannot return anything right now, so every search it runs
-- spends budget on a call that provably cannot succeed.
--
--   * Google CSE returns HTTP 403 "This project does not have the access to
--     Custom Search JSON API" on EVERY call. Proven 2026-08-19 by direct
--     probe: a bogus cx returns the IDENTICAL error, so the request is
--     rejected at the project-access layer before the search engine is ever
--     evaluated. A bogus KEY returns a different error ("API key not valid"),
--     so the key itself is valid. Project 994511695173 is confirmed correct,
--     the API shows as enabled, and Gemini serves fine on the same project --
--     so this is Custom-Search-specific and sits above the project level.
--   * SerpAPI, the fallback, is exhausted: 250/250 used, resets 2026-08-25.
--
-- searchAll() cannot tell a 403 from a genuine zero-result -- both become []
-- -- which is how a total CSE outage hid for days and burned the entire
-- SerpAPI quota. Until CSE is restored, running the worker converts search
-- budget into nothing at a rate of 80/day.
--
-- Deliberately UNSCHEDULED rather than gated behind a WHERE predicate: a
-- disabled job that still fires every 10 minutes leaves noise in cron history
-- and invites the assumption that it is doing something.
--
-- ⚠️ NOT a fix. The fix is a working GOOGLE_API_KEY. Restore as soon as the
-- probe returns HTTP 200 with real result links.
--
-- ── TO RESTORE, run exactly this (identical to migration 20260816140000) ──
--
--   SELECT cron.schedule(
--     'auto-source-new-listings-10min',
--     '6-56/10 * * * *',
--     $cron$
--     SELECT net.http_post(
--       url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/auto-source-new-listings',
--       headers := (
--         SELECT jsonb_build_object(
--           'Content-Type',      'application/json',
--           'x-internal-secret', decrypted_secret::text
--         )
--         FROM vault.decrypted_secrets
--         WHERE name = 'INTERNAL_SYNC_SECRET'
--         LIMIT 1
--       ),
--       body := jsonb_build_object('triggered_by', 'cron-auto-source-10min', 'time', now()::text),
--       timeout_milliseconds := 120000
--     );
--     $cron$
--   );
--
-- cron.schedule upserts on job name, so re-running it is safe and idempotent.

DO $$
BEGIN
  PERFORM cron.unschedule('auto-source-new-listings-10min');
  RAISE NOTICE 'auto-source-new-listings-10min UNSCHEDULED (Google CSE 403 + SerpAPI exhausted)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'auto-source-new-listings-10min was not scheduled, nothing to unschedule';
END $$;

-- Detection itself is NOT paused. check-seller-watchlist keeps running its
-- overnight window: it uses Keepa and SP-API, not the search APIs, so it is
-- unaffected by this outage. New listings continue to be detected and will sit
-- at source_status 'unsourced' waiting for search to come back -- which is the
-- correct queue behaviour, not a backlog to worry about.
--
-- One consequence worth knowing: seller_watch_new_listings rows expire
-- unsearched after 5 days (disqualified_reason 'expired'). If CSE stays broken
-- past 2026-08-24, listings detected today will age out without ever being
-- searched. That is a reason to fix the key, not a reason to keep burning
-- budget now.
