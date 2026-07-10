
INSERT INTO public.created_listing_purchases (listing_id, user_id, units, unit_cost, total_cost, note, purchase_date, created_at)
SELECT 
  id AS listing_id,
  user_id,
  COALESCE(units, 0) AS units,
  CASE 
    WHEN COALESCE(units, 0) > 0 AND COALESCE(cost, 0) > 0 THEN cost / units
    WHEN COALESCE(amount, 0) > 0 THEN amount
    ELSE 0
  END AS unit_cost,
  COALESCE(cost, 0) AS total_cost,
  'Initial purchase (backfilled)' AS note,
  COALESCE(date_created, created_at) AS purchase_date,
  created_at
FROM public.created_listings
WHERE COALESCE(units, 0) > 0 OR COALESCE(cost, 0) > 0;
