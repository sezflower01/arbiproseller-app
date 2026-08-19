-- Strict mode for auto-sourcing.
--
-- WHY THIS IS NOT PART OF QUALIFICATION. evaluateQualification() decides "is
-- this the kind of product we ever source" and runs on every detection. Strict
-- mode decides "is this worth one of 80 daily CSE/Gemini searches", and that
-- budget was 80/80 consumed on 2026-08-17 -- it is the binding constraint. So
-- the rules live at the pre-search step: a listing that fails strict mode is
-- still a real detection, still visible, and still has its price and fees. It
-- just does not consume search budget.
--
-- THE OFFER COUNTS ARE NOT FREE, and the earlier plan that said they were is
-- wrong. Measured live 2026-08-19:
--   * stats.current[11] (COUNT_NEW) IS populated by stats=1 alone at
--     tokensConsumed 1 -- confirmed on 3 ASINs.
--   * But it counts FBA AND FBM together. B00JSWP62I reported COUNT_NEW 2 with
--     ZERO FBA offers; B0D8H77XRY reported 1 with zero FBA. An FBA-only rule
--     built on it would have been measuring the wrong thing entirely.
-- Per-offer isFBA needs offers=20, measured at 5-6 tokens vs 1. Applied to the
-- ~11 qualified ASINs/day that already get a price call, that is ~60 tokens/day
-- against a 7,200/day refill -- under 1%, and accepted deliberately.

ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS fba_offer_count    integer,
  ADD COLUMN IF NOT EXISTS fbm_offer_count    integer,
  ADD COLUMN IF NOT EXISTS seller_offer_is_fba boolean,
  ADD COLUMN IF NOT EXISTS offers_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS strict_reason      text;

COMMENT ON COLUMN public.seller_watch_new_listings.fba_offer_count IS
  'Live New offers with isFBA true, from Keepa offers=20. NULL means offers were never captured (Keepa refused or the run ran out of time) -- that is UNKNOWN, not zero, and strict mode lets it pass so an outage cannot silently empty the search queue.';

COMMENT ON COLUMN public.seller_watch_new_listings.seller_offer_is_fba IS
  'Whether the WATCHED seller''s own offer on this ASIN is FBA, matched by exact sellerId inside Keepa''s live offers array (verified 2/2 on real watches 2026-08-19). NULL means the seller was not found in the live snapshot -- they can legitimately drop out between detection and this call, so NULL is unknown and does NOT reject.';

COMMENT ON COLUMN public.seller_watch_new_listings.strict_reason IS
  'Why strict mode withheld a search: seller_offer_is_fbm | no_sales_rank | fba_offers_N_below_M | est_sales_N_below_M. NULL when it passed or strict mode is off. Stored so a shrinking search queue is diagnosable rather than mysterious.';

-- Per-user settings. Thresholds are columns rather than constants so they can
-- be tuned without a deploy; the defaults are the ones agreed 2026-08-19.
ALTER TABLE public.auto_source_config
  ADD COLUMN IF NOT EXISTS strict_mode                boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS strict_min_fba_offers      integer NOT NULL DEFAULT 4
    CHECK (strict_min_fba_offers >= 0 AND strict_min_fba_offers <= 100),
  ADD COLUMN IF NOT EXISTS strict_min_monthly_sales   integer NOT NULL DEFAULT 50
    CHECK (strict_min_monthly_sales >= 0 AND strict_min_monthly_sales <= 100000),
  ADD COLUMN IF NOT EXISTS strict_require_rank        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS strict_require_seller_fba  boolean NOT NULL DEFAULT true;

-- Defaults to OFF deliberately. Enabling it changes which detections consume
-- search budget, and that should be a decision someone makes in the UI rather
-- than something a migration does to a live account.
COMMENT ON COLUMN public.auto_source_config.strict_mode IS
  'Master switch for the pre-search commercial filter. OFF by default so deploying this migration changes no behaviour.';

COMMENT ON COLUMN public.auto_source_config.strict_min_monthly_sales IS
  'Default 50, NOT 10. The existing MAX_SALES_RANK of 500,000 already implies ~38 sales/month on the estimator curve, so a 10/month rule would have been inert by construction. 50/month corresponds to rank ~317,000 and genuinely bites the 317k-500k band.';

COMMENT ON COLUMN public.auto_source_config.strict_require_rank IS
  'Rejects detections with no broad sales rank. Highest-impact rule here: qualification applies its rank ceiling ONLY when a rank exists, and 60% of detections carry none -- so six in ten skip that check entirely today.';

-- Lets the pre-search picker skip strict-mode failures without a full scan.
CREATE INDEX IF NOT EXISTS idx_swnl_source_status_strict
  ON public.seller_watch_new_listings (user_id, source_status)
  WHERE strict_reason IS NULL;
