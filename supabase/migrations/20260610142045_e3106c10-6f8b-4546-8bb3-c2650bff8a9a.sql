-- Backfill: flip repricer_assignments.fulfillment_type from FBM to FBA when
-- inventory shows hard FBA evidence (FNSKU present OR reserved>0 OR inbound>0
-- OR source=amazon_sync). Mirrors the new UI detection logic so existing rows
-- get cleaned up too.
WITH fba_evidence AS (
  SELECT DISTINCT i.user_id, i.asin
  FROM public.inventory i
  WHERE
    (i.fnsku IS NOT NULL AND length(trim(i.fnsku)) > 0)
    OR COALESCE(i.reserved, 0) > 0
    OR COALESCE(i.inbound, 0) > 0
    OR lower(COALESCE(i.source, '')) = 'amazon_sync'
)
UPDATE public.repricer_assignments ra
SET
  fulfillment_type = 'FBA',
  updated_at = now()
FROM fba_evidence e
WHERE ra.user_id = e.user_id
  AND ra.asin = e.asin
  AND COALESCE(ra.fulfillment_type, '') = 'FBM';