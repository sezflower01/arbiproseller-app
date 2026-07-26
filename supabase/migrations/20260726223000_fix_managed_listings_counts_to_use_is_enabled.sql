-- get_managed_listings_counts previously counted ANY repricer_assignments row
-- with rule_id NOT NULL, regardless of is_enabled -- so a suspended/disabled
-- ASIN kept counting toward plan usage forever. Confirmed live on a real
-- account: 3,169 counted vs. 1,808 actually is_enabled=true (1,361 of the gap
-- were auto_suspended_reason rows). This contradicted:
--   1. The Pricing page's own promise ("only active listings count... the
--      moment an ASIN goes inactive, it auto-deactivates and stops counting")
--   2. auto-onboard-asin's own real-time counter, which already filters
--      is_enabled = true
--   3. What repricer-billing-cycle-check uses to decide auto-upgrades --
--      left unfixed, it would upgrade accounts based on dead assignments,
--      not real usage.
--
-- Now filters is_enabled = true and mirrors auto-onboard-asin's intl
-- eligibility exclusion (bad-status intl assignments never consumed real
-- capacity there either).

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
    WHERE a.user_id = p_user_id
      AND a.rule_id IS NOT NULL
      AND a.is_enabled = true
      AND (
        a.marketplace = 'US'
        OR COALESCE(a.intl_listing_status, '') NOT IN ('UNKNOWN', 'NOT_FOUND', 'INACTIVE', '[]', '')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.inventory i
        WHERE i.user_id = a.user_id
          AND i.asin = a.asin
          AND UPPER(COALESCE(i.listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED')
      )
    GROUP BY a.marketplace
  ) sub;
$$;

COMMENT ON FUNCTION public.get_managed_listings_counts(uuid) IS
  'Plan-usage counter (assigned repricer slots). Counts repricer_assignments rows with '
  'rule_id NOT NULL AND is_enabled = true, excluding ineligible-status intl assignments '
  'and tombstoned inventory. Matches what the Repricer''s own Assignments view shows and '
  'what the Pricing page promises: only active listings count toward plan usage.';
