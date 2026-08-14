-- Supports the repricer-matched-cohort edge function (Task #107): per-ASIN
-- day-level aggregates so an ASIN's exposure to more than one preset can be
-- windowed and compared, instead of relying only on account-wide aggregate
-- totals. Same reasoning as the other repricer_rule_perf_* / rule_perf
-- RPCs in this file's siblings -- these source tables are too high-volume
-- to page through the edge function, and the earlier raise-safety RPC
-- already proved that an unscoped scan over repricer_ai_decisions times
-- out, so every one of these is scoped by an explicit rule_id or asin list
-- passed in from the edge function (which derives that list cheaply first).
--
-- NOTE: repricer_asin_profile_days below was rewritten in a later migration
-- (20260814062000) after this day-level version still timed out even
-- scoped to a single rule_id -- see that file for why. Left here unedited
-- for history; the DROP/CREATE in the later file supersedes it.

-- 1. Per-ASIN, per-day decision counts + V2-gate event counts, scoped to a
-- caller-supplied rule_id list (the account's Momentum Builder / Smart
-- Match / Momentum Smart rule(s)) so this doesn't scan the whole
-- 1.7M+-row table. avg_offers_count feeds the "competition level" matched-
-- cohort dimension.
CREATE OR REPLACE FUNCTION public.repricer_asin_profile_days(p_user_id uuid, p_since timestamptz, p_rule_ids uuid[])
RETURNS TABLE(
  asin text,
  marketplace text,
  rule_id uuid,
  decision_day date,
  decision_count bigint,
  raise_attempts bigint,
  cooldown_blocks bigint,
  floor_rejects bigint,
  avg_offers_count numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    d.asin,
    d.marketplace,
    d.rule_id,
    d.created_at::date AS decision_day,
    COUNT(*)::bigint AS decision_count,
    COUNT(*) FILTER (WHERE d.mode = 'SMART_RAISE')::bigint AS raise_attempts,
    COUNT(*) FILTER (WHERE d.raise_blocked_cooldown)::bigint AS cooldown_blocks,
    COUNT(*) FILTER (WHERE d.raise_rejected_floor_support)::bigint AS floor_rejects,
    AVG(d.offers_count) AS avg_offers_count
  FROM repricer_ai_decisions d
  WHERE d.user_id = p_user_id
    AND d.created_at >= p_since
    AND d.rule_id = ANY(p_rule_ids)
  GROUP BY 1, 2, 3, 4
$$;

-- 2. Per-ASIN, per-day sales, scoped to a caller-supplied ASIN list (the
-- candidate ASINs identified from #1) rather than the whole account.
CREATE OR REPLACE FUNCTION public.repricer_asin_sales_days(p_user_id uuid, p_since timestamptz, p_asins text[])
RETURNS TABLE(
  asin text,
  marketplace text,
  order_day date,
  units bigint,
  revenue numeric,
  cost numeric,
  fees numeric,
  order_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    so.asin,
    so.marketplace,
    so.order_date::date AS order_day,
    SUM(so.quantity)::bigint AS units,
    SUM(COALESCE(so.total_sale_amount, 0)) AS revenue,
    SUM(COALESCE(so.total_cost, 0)) AS cost,
    SUM(COALESCE(so.total_fees, 0)) AS fees,
    COUNT(*)::bigint AS order_count
  FROM sales_orders so
  WHERE so.user_id = p_user_id
    AND so.order_date >= p_since
    AND so.is_cancelled = false
    AND so.asin = ANY(p_asins)
  GROUP BY 1, 2, 3
$$;

-- 3. Per-ASIN, per-day Buy Box snapshot tally, scoped the same way. Own
-- seller id varies by marketplace, so it's passed as a small jsonb map
-- ({"US": "A2...", "CA": "A3..."}) rather than joined from a table.
CREATE OR REPLACE FUNCTION public.repricer_asin_bb_days(p_user_id uuid, p_since timestamptz, p_asins text[], p_seller_ids jsonb)
RETURNS TABLE(
  asin text,
  marketplace text,
  snapshot_day date,
  total_snapshots bigint,
  winning_snapshots bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.asin,
    s.marketplace,
    s.fetched_at::date AS snapshot_day,
    COUNT(*)::bigint AS total_snapshots,
    COUNT(*) FILTER (WHERE s.buybox_seller_id = (p_seller_ids ->> s.marketplace))::bigint AS winning_snapshots
  FROM repricer_competitor_snapshots s
  WHERE s.user_id = p_user_id
    AND s.fetched_at >= p_since
    AND s.asin = ANY(p_asins)
  GROUP BY 1, 2, 3
$$;

-- 4. Every raise for a caller-supplied ASIN list, unlimited (unlike
-- repricer_rule_perf_raises' account-wide p_limit) -- once scoped to a
-- specific, already-small ASIN candidate set this stays cheap, and an
-- account-wide cap would otherwise silently starve less-active ASINs of
-- their raise history in favor of the account's busiest ones.
CREATE OR REPLACE FUNCTION public.repricer_asin_raises(p_user_id uuid, p_since timestamptz, p_asins text[])
RETURNS TABLE(
  asin text,
  sku text,
  marketplace text,
  old_price numeric,
  new_price numeric,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT asin, sku, marketplace, old_price, new_price, created_at
  FROM repricer_price_actions
  WHERE user_id = p_user_id
    AND created_at >= p_since
    AND new_price IS NOT NULL
    AND old_price IS NOT NULL
    AND new_price > old_price
    AND asin = ANY(p_asins)
  ORDER BY created_at ASC
$$;

REVOKE ALL ON FUNCTION public.repricer_asin_profile_days(uuid, timestamptz, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repricer_asin_sales_days(uuid, timestamptz, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repricer_asin_bb_days(uuid, timestamptz, text[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repricer_asin_raises(uuid, timestamptz, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repricer_asin_profile_days(uuid, timestamptz, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.repricer_asin_sales_days(uuid, timestamptz, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.repricer_asin_bb_days(uuid, timestamptz, text[], jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.repricer_asin_raises(uuid, timestamptz, text[]) TO service_role;
