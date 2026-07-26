-- Fix to the previous migration (20260726234500): it only excluded
-- NOT_IN_CATALOG/DELETED, dropping the INACTIVE/INCOMPLETE/SUPPRESSED
-- exclusions that the original migration (and AssignmentsTable.tsx's own
-- Stage A filter) both had. That regression let 94 US rows with
-- listing_status = 'INACTIVE' still count toward billing (357 total vs.
-- the correct 263), which is well above what Seller Central and the
-- repricer's own assignments table show as actually active (~250-263).
--
-- Widens the exclusion list back to match AssignmentsTable.tsx's Stage A
-- check exactly: NOT_IN_CATALOG, DELETED, INACTIVE, INCOMPLETE, SUPPRESSED.
-- Confirmed live: US 357 -> 263, BR/CA/MX essentially unchanged (110/67/114
-- vs previous 112/68/116 -- those marketplaces rarely had this status in
-- the first place since the BUYABLE check already filters most of it out).

CREATE OR REPLACE FUNCTION public.get_managed_listings_counts(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'total', COALESCE(SUM(cnt), 0),
    'per_marketplace', COALESCE(
      jsonb_object_agg(marketplace, cnt),
      '{}'::jsonb
    )
  )
  FROM (
    SELECT a.marketplace, COUNT(*) AS cnt
    FROM public.repricer_assignments a
    JOIN public.inventory i
      ON i.user_id = a.user_id
      AND i.sku = a.sku
    WHERE a.user_id = p_user_id
      AND a.rule_id IS NOT NULL
      AND (
        COALESCE(i.available, 0) > 0
        OR COALESCE(i.reserved, 0) > 0
        OR COALESCE(i.inbound, 0) > 0
      )
      AND UPPER(COALESCE(i.listing_status, '')) NOT IN (
        'NOT_IN_CATALOG', 'DELETED', 'INACTIVE', 'INCOMPLETE', 'SUPPRESSED'
      )
      AND (
        a.marketplace = 'US'
        OR a.intl_listing_status ILIKE '%BUYABLE%'
      )
    GROUP BY a.marketplace
  ) sub;
$$;

COMMENT ON FUNCTION public.get_managed_listings_counts(uuid) IS
  'Plan-usage counter (assigned repricer slots). Counts repricer_assignments rows with '
  'rule_id NOT NULL, joined to inventory on (user_id, sku), where there is real current '
  'stock (available/reserved/inbound > 0), the listing status is not NOT_IN_CATALOG/'
  'DELETED/INACTIVE/INCOMPLETE/SUPPRESSED, and -- for non-US marketplaces -- '
  'intl_listing_status confirms BUYABLE. Matches the same operational definition the '
  'repricer assignments table itself uses (evaluateSellability / Stage A filter) to '
  'decide what is shown/repriceable.';
