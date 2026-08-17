-- Backfill `qualified` for listings detected before qualification existed.
--
-- The auto-source worker now filters on `qualified = true`. Rows detected
-- earlier carry NULL, so without this they would be silently unreachable --
-- never searched, never explained, just quietly dropped until the 5-day expiry
-- swept them away. A filter that makes existing data invisible is a migration
-- bug, not a feature.
--
-- These rows never had product_group or sales_rank captured (those columns
-- arrived with the same change), so only the UPC rule can be applied. That is
-- the strongest signal anyway -- 48% of detections -- and the honest thing is
-- to record WHY each verdict was reached rather than pretend a full assessment
-- happened.
UPDATE public.seller_watch_new_listings
   SET qualified = (upc IS NOT NULL AND btrim(upc) <> ''),
       disqualified_reason = CASE
         WHEN upc IS NULL OR btrim(upc) = '' THEN 'no_upc'
         ELSE NULL
       END
 WHERE qualified IS NULL
   AND source_status = 'unsourced';

-- Terminal rows are left with qualified NULL on purpose: they have already
-- been searched, so whether they WOULD have qualified is a question with no
-- consequence, and inventing a verdict would misrepresent it as assessed.
