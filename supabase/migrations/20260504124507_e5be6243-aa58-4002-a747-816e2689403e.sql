-- Set fulfillment_type='FBA' on assignments wrongly tagged 'FBM' whose inventory
-- clearly proves the listing is FBA (FNSKU present OR FBA stock > 0).
-- Cannot use NULL because the column is NOT NULL; FBA is the proven correct value.
UPDATE public.repricer_assignments ra
SET fulfillment_type = 'FBA'
WHERE ra.fulfillment_type = 'FBM'
  AND EXISTS (
    SELECT 1
    FROM public.inventory inv
    WHERE inv.user_id = ra.user_id
      AND inv.asin = ra.asin
      AND (
        (inv.fnsku IS NOT NULL AND inv.fnsku <> '')
        OR COALESCE(inv.available, 0) + COALESCE(inv.reserved, 0) + COALESCE(inv.inbound, 0) > 0
      )
  );