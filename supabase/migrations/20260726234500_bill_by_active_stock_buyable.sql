-- Third revision of get_managed_listings_counts. Previous revisions:
--   20260726223000: is_enabled = true
--   20260726231500: last_evaluated_at IS NOT NULL (heartbeat), independent of is_enabled
--
-- Per clarification: billing should count what's actually active and has
-- stock (including inbound) -- matching the same operational definition the
-- repricer's own assignments table already uses to decide what's shown/
-- repriceable, not a looser "ever proven once" heartbeat concept. A listing
-- that's had zero stock for months and/or lost Amazon's BUYABLE status on a
-- marketplace isn't a real slot anymore, even if it was real once.
--
-- Definition, confirmed live against the test account (020dd71f-78ce-4bc2-
-- 9117-dc997c533ab9): rule_id assigned, real current stock (available,
-- reserved, or inbound > 0), not tombstoned, and -- for non-US marketplaces
-- -- Amazon-confirmed BUYABLE via intl_listing_status (matching the same
-- gate AssignmentsTable.tsx's evaluateSellability() applies before showing a
-- row). Joins inventory on (user_id, sku), not (user_id, asin): inventory is
-- unique per sku (one ASIN can have multiple SKUs/inventory rows), so the
-- previous asin-keyed join could match the wrong row.

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
      AND UPPER(COALESCE(i.listing_status, '')) NOT IN ('NOT_IN_CATALOG', 'DELETED')
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
  'stock (available/reserved/inbound > 0), the listing is not tombstoned '
  '(NOT_IN_CATALOG/DELETED), and -- for non-US marketplaces -- intl_listing_status '
  'confirms BUYABLE. Matches the same operational definition the repricer assignments '
  'table itself uses to decide what is shown/repriceable, not a looser ever-onboarded '
  'heartbeat concept.';
