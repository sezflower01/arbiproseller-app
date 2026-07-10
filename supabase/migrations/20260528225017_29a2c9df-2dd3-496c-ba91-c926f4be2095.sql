
-- Phase 3 billing alignment: count assigned repricer slots, not "active listings with stock".
-- Per Assignment Status Contract: visibility, evaluator eligibility, and plan counting are
-- three independent concepts. This function owns ONLY plan counting.
--
-- A slot is counted when:
--   - the row belongs to the user
--   - rule_id IS NOT NULL (user intentionally assigned a rule)
--   - the underlying inventory row is NOT tombstoned (NOT_IN_CATALOG / DELETED)
--
-- It does NOT depend on:
--   is_enabled, manual_paused, auto_suspended_reason, amazon_listing_state,
--   available/reserved/inbound stock, marketplace_sellable, intl freshness.
--
-- Rationale: users pay for the assignment slot they hold (onboarded + rule attached),
-- not for whether Amazon happens to have the listing live this minute.

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
  'rule_id NOT NULL whose underlying inventory is not tombstoned. Independent of '
  'is_enabled, manual_paused, auto_suspended_reason, amazon_listing_state, and stock. '
  'Repricer visibility and evaluator eligibility are separate.';
