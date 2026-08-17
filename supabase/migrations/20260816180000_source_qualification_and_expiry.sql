-- Qualify which new listings are worth an automatic source search, raise the
-- daily cap to match the real rate, and expire listings that were never
-- searched.
--
-- WHY: 281 listings were detected in one day against a 40/day cap, leaving 204
-- permanently queued. Raising the cap alone would just buy more searches for
-- results that were never worth having -- a single bookseller can dump 25
-- out-of-print titles in one 5-minute tick.
--
-- Filter criteria come from probing 40 REAL detections via SP-API Catalog
-- Items on 2026-08-16, not from assumption:
--
--   * productGroup is the usable category field. browseClassification returns
--     LEAF nodes ("Toggle Valves", "Cross-Stitch") that no sensible rule would
--     match. Observed groups: BISS Basic 10, Personal Computer 5, Toy 4,
--     Book 3, DVD 2, Video 2, Music 1, ...
--   * Amazon's strings are 'Book', 'DVD', 'Video', 'Music' -- NOT "Books" or
--     "Movies & TV". A rule written from intuition would have matched nothing.
--   * displayGroupRanks is the real BSR ("Video Games" #4,540).
--     classificationRanks is the narrow leaf rank ("PlayStation 4 Games" #194)
--     and is not comparable across products. Distribution of the real rank:
--     min 4,540 / p25 28,335 / median 80,142 / p75 511,275 / max 1,886,054.
--     The 500,000 ceiling trims roughly the worst quartile.
--   * Only 16/40 (40%) carry a broad rank at all, so the ceiling applies ONLY
--     when a rank exists. Excluding unranked items would punish missing data
--     rather than bad products.
--   * No-UPC is the strongest single signal at 48% of detections, and it is
--     principled: the search is UPC-first and degrades badly without one,
--     which is why untagged items return "no likely sources".
--   * ISBN-style ASINs were only 2/40, so that rule was dropped as noise.

ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS product_group text,
  ADD COLUMN IF NOT EXISTS sales_rank integer,
  ADD COLUMN IF NOT EXISTS qualified boolean,
  ADD COLUMN IF NOT EXISTS disqualified_reason text;

COMMENT ON COLUMN public.seller_watch_new_listings.product_group IS
  'SP-API summaries[].websiteDisplayGroupName -- top-level department (Book, DVD, Toy). NOT browseClassification, which is a leaf node.';
COMMENT ON COLUMN public.seller_watch_new_listings.sales_rank IS
  'SP-API salesRanks[].displayGroupRanks[].rank -- the broad BSR. NOT classificationRanks, which is a narrow subcategory rank.';
COMMENT ON COLUMN public.seller_watch_new_listings.qualified IS
  'NULL = not yet assessed. Only qualified rows are auto-searched.';

-- 'expired' joins the terminal statuses: searched-and-nothing-found is a
-- different outcome from never-searched, and conflating them would hide how
-- much the queue is dropping.
ALTER TABLE public.seller_watch_new_listings
  DROP CONSTRAINT IF EXISTS seller_watch_new_listings_source_status_check;
ALTER TABLE public.seller_watch_new_listings
  ADD CONSTRAINT seller_watch_new_listings_source_status_check
  CHECK (source_status IN ('unsourced','sourcing','candidates_found','sourced','no_candidates','expired'));

-- The auto-source worker's hot path: unsourced AND qualified, newest first.
CREATE INDEX IF NOT EXISTS idx_new_listings_qualified_queue
  ON public.seller_watch_new_listings (user_id, detected_at DESC)
  WHERE source_status = 'unsourced' AND qualified IS TRUE;

-- 40/day was set before the real rate was known; 281 detections in a day made
-- it permanently binding. 80 sits near the qualified rate (~a third of
-- detections survive filtering) and stays under Google CSE's 100/day free
-- tier, so automation still cannot silently start costing money.
ALTER TABLE public.auto_source_config ALTER COLUMN daily_cap SET DEFAULT 80;
UPDATE public.auto_source_config SET daily_cap = 80, updated_at = now() WHERE daily_cap = 40;

-- Retire listings that were never searched. After five days the arbitrage
-- window has closed, so holding them forever only grows a queue nobody will
-- ever work through. Terminal, and distinguishable from a real search result.
CREATE OR REPLACE FUNCTION public.expire_stale_new_listings(p_days integer DEFAULT 5)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.seller_watch_new_listings
     SET source_status = 'expired'
   WHERE source_status = 'unsourced'
     AND detected_at < now() - make_interval(days => GREATEST(p_days, 1));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_new_listings(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_new_listings(integer) TO service_role;
