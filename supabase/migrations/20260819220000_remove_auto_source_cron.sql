-- Permanently remove the auto-source search worker.
--
-- Automated Find Source is gone. Search is now a manual "Search on Google"
-- link on each detected listing, using the listing TITLE only.
--
-- WHY: Google CSE returned 403 PERMISSION_DENIED on every call across three
-- projects and two Google accounts, with the API enabled and billing linked on
-- each, reproduced from a browser as well as server-side -- an unresolved
-- Google-side issue (support case filed 2026-08-19). SerpAPI absorbed the
-- failures until its 250/month quota was exhausted. Rather than pay for search
-- capacity to automate a judgement the seller was reviewing manually anyway,
-- the automation is removed and the judgement made explicit.
--
-- WHAT SURVIVES, and why it is not dead weight:
--   * Detection (check-seller-watchlist) -- Keepa/SP-API, untouched.
--   * Qualification -- restricted, brand, category and the needs-approval
--     toggle now filter what is worth the SELLER'S ATTENTION rather than what
--     is worth an API call. That was always a second reason for them.
--   * Price capture (new_price_cents) -- free, from a Keepa call already made,
--     and shown beside the search button as the "worth clicking" signal.
--
-- The 20260819160000 migration already unscheduled this job as a temporary
-- pause. This makes it permanent and removes the accompanying function.
--
-- COLUMNS ARE DELIBERATELY NOT DROPPED HERE. candidates, sourced_candidate,
-- rejected_candidate_urls and the strict_* columns still hold real historical
-- data. Dropping them is destructive and irreversible, so it is a separate
-- migration to be run once the history is confirmed unwanted. Nothing selects
-- them any more, so they cost only storage.

DO $$
BEGIN
  PERFORM cron.unschedule('auto-source-new-listings-10min');
  RAISE NOTICE 'auto-source-new-listings-10min removed permanently (search is now manual)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'auto-source-new-listings-10min already unscheduled';
END $$;
