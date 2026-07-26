-- Second correction to get_managed_listings_counts (see the previous
-- migration, 20260726223000, which switched it to is_enabled = true).
-- Per clarification: billing should NOT depend on is_enabled at all --
-- a paused/suspended assignment still holds its slot and should keep
-- counting, as long as it's PROVEN real (not a "ghost" row where
-- onboarding never actually completed a real evaluation cycle).
--
-- The real "is this a genuine slot" signal is last_evaluated_at: it's set
-- the first time the repricer actually evaluates the assignment. Confirmed
-- live: of 3,640 rule_id-assigned rows, 2,270 have a real heartbeat and
-- 1,370 are true ghosts (rule_id set, never evaluated -- some over 5
-- months old, not "still onboarding"). Billing should count the 2,270,
-- not the is_enabled=true subset (1,270) and not the raw rule_id count
-- (3,640, which includes ghosts).

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
      AND a.last_evaluated_at IS NOT NULL
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
  'rule_id NOT NULL AND last_evaluated_at NOT NULL (proven real via at least one '
  'repricer heartbeat -- excludes ghost rows that never completed onboarding), '
  'excluding ineligible-status intl assignments and tombstoned inventory. '
  'Independent of is_enabled/manual_paused/auto_suspended_reason: a paused '
  'assignment still holds its slot and keeps counting.';
