-- Let a user say "this is NOT the source" and have it stick.
--
-- Find Source returns ranked candidates and the user can mark one as THE
-- source, but there was no way to rule one out. That matters more than it
-- sounds: the judgement a user makes is usually negative and specific --
-- "this is the right product but it arrives via Instacart rather than the
-- brand's own store, so it is not a source I can buy from" -- and that
-- reasoning is invisible to the scorer, which only sees text and image
-- similarity. The candidate keeps scoring as a likely match forever.
--
-- Without persistence, "Search again" simply returns the same rejected
-- candidates and the user re-rejects them every run. So this is stored on the
-- row rather than being a client-side hide, and find-source-candidates filters
-- against it before saving new results.
--
-- Stores URLs, not domains. A retailer that is wrong for one product can be
-- right for another, so a domain-level block would over-reach from a single
-- judgement. A global "never suggest this retailer" preference is a separate,
-- deliberate feature if it is ever wanted.
ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS rejected_candidate_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.seller_watch_new_listings.rejected_candidate_urls IS
  'URLs the user explicitly marked as NOT the source. find-source-candidates excludes these from future runs so a rejection survives re-searching.';
