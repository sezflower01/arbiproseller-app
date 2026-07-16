-- resolve_unit_cost_v1: enforce calendar-year boundary on historical cost
-- tiers (asin_cost_overrides, cost_history, purchases/listings). Previously
-- these tiers picked "whatever cost was most recently in effect at or before
-- the order date" with no year restriction, so an order early in a new year
-- (before that year's first purchase was logged) would silently reach back
-- into the prior year's — or even an older year's — purchase cost.
--
-- Now: each of those tiers only considers events in the SAME calendar year
-- as p_order_date. If nothing qualifies in that year, the tier is skipped
-- entirely (v_cost stays NULL) and resolution falls through to the next
-- tier, ultimately landing on the inventory.cost fallback (tier 5) instead
-- of stale prior-year pricing.
--
-- Tier 1 (locked sale-time snapshot) and tier 4 (legacy no-date fallback,
-- only used when p_order_date IS NULL) are unaffected — there's no order-date
-- year to compare against in either case. Tier 5 (inventory fallback) is
-- unaffected — it's the destination we now fall through to.
CREATE OR REPLACE FUNCTION public.resolve_unit_cost_v1(
  p_user_id uuid, p_asin text, p_sku text, p_order_date date,
  p_snapshot_unit_cost numeric DEFAULT NULL::numeric
)
RETURNS TABLE(unit_cost numeric, source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_cost numeric;
  v_source text;
  v_valid_asin boolean := p_asin IS NOT NULL AND btrim(p_asin) <> '' AND p_asin <> 'PENDING' AND p_asin <> 'UNKNOWN';
  v_valid_sku  boolean := p_sku  IS NOT NULL AND btrim(p_sku)  <> '';
BEGIN
  -- 1. Locked sale-time snapshot wins.
  IF COALESCE(p_snapshot_unit_cost, 0) > 0 THEN
    RETURN QUERY SELECT round(p_snapshot_unit_cost::numeric, 2), 'salesOrders'::text;
    RETURN;
  END IF;

  -- 2. Manual override (date-aware, same calendar year as the order only).
  IF v_valid_asin AND p_order_date IS NOT NULL THEN
    SELECT o.unit_cost INTO v_cost
    FROM public.asin_cost_overrides o
    WHERE o.user_id = p_user_id AND o.asin = p_asin AND o.effective_from <= p_order_date
      AND EXTRACT(YEAR FROM o.effective_from) = EXTRACT(YEAR FROM p_order_date)
    ORDER BY o.effective_from DESC LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'manualOverride'::text;
      RETURN;
    END IF;
  END IF;

  -- 3a. Immutable cost_history (preferred). Strict: effective_date AND
  -- recorded_at both <= order_date, AND same calendar year as order_date.
  IF p_order_date IS NOT NULL AND (v_valid_sku OR v_valid_asin) THEN
    SELECT h.cost, 'costHistory'::text
      INTO v_cost, v_source
    FROM public.cost_history h
    WHERE h.user_id = p_user_id
      AND h.cost > 0
      AND h.effective_date <= p_order_date
      AND h.recorded_at::date <= p_order_date
      AND EXTRACT(YEAR FROM h.effective_date) = EXTRACT(YEAR FROM p_order_date)
      AND (
        (v_valid_sku  AND h.sku  = p_sku)
        OR (v_valid_asin AND h.asin = p_asin)
      )
    ORDER BY
      CASE WHEN v_valid_sku AND h.sku = p_sku THEN 0 ELSE 1 END,
      h.effective_date DESC,
      h.recorded_at DESC
    LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), v_source;
      RETURN;
    END IF;
  END IF;

  -- 3b. Purchase batches + created_listings unified timeline, with STRICT
  -- 3-clause guard on listings, restricted to the same calendar year as the order.
  IF p_order_date IS NOT NULL AND (v_valid_sku OR v_valid_asin) THEN
    WITH cost_candidates AS (
      SELECT
        p.unit_cost::numeric AS candidate_cost,
        CASE WHEN v_valid_sku AND cl.sku = p_sku THEN 0 ELSE 1 END AS match_rank,
        p.purchase_date AS cost_ts,
        p.created_at AS created_ts,
        p.id::text AS stable_id,
        0 AS tie_rank,
        'purchaseBatch'::text AS candidate_source
      FROM public.created_listing_purchases p
      JOIN public.created_listings cl ON cl.id = p.listing_id
      WHERE p.user_id = p_user_id AND cl.user_id = p_user_id
        AND p.unit_cost > 0
        AND p.purchase_date < (p_order_date::timestamp with time zone + interval '1 day')
        AND EXTRACT(YEAR FROM p.purchase_date) = EXTRACT(YEAR FROM p_order_date)
        AND ((v_valid_sku AND cl.sku = p_sku) OR (v_valid_asin AND cl.asin = p_asin))

      UNION ALL

      SELECT
        CASE
          WHEN COALESCE(cl.amount,0) > 0 THEN cl.amount
          WHEN COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0 THEN cl.cost / cl.units
          ELSE NULL
        END::numeric AS candidate_cost,
        CASE WHEN v_valid_sku AND cl.sku = p_sku THEN 0 ELSE 1 END AS match_rank,
        COALESCE(cl.date_created::timestamp with time zone, cl.created_at) AS cost_ts,
        cl.created_at AS created_ts,
        cl.id::text AS stable_id,
        1 AS tie_rank,
        'listingsHistorical'::text AS candidate_source
      FROM public.created_listings cl
      WHERE cl.user_id = p_user_id
        AND ((v_valid_sku AND cl.sku = p_sku) OR (v_valid_asin AND cl.asin = p_asin))
        -- STRICT 3-clause guard
        AND COALESCE(cl.date_created, cl.created_at::date) <= p_order_date
        AND cl.created_at::date <= p_order_date
        AND cl.updated_at::date <= p_order_date
        AND EXTRACT(YEAR FROM COALESCE(cl.date_created, cl.created_at::date)) = EXTRACT(YEAR FROM p_order_date)
        AND (COALESCE(cl.amount,0) > 0 OR (COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0))
    )
    SELECT c.candidate_cost, c.candidate_source INTO v_cost, v_source
    FROM cost_candidates c WHERE COALESCE(c.candidate_cost,0) > 0
    ORDER BY c.match_rank ASC, c.cost_ts DESC NULLS LAST, c.created_ts DESC NULLS LAST,
             c.tie_rank ASC, c.stable_id DESC
    LIMIT 1;
    IF COALESCE(v_cost,0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), COALESCE(v_source,'listingsHistorical')::text;
      RETURN;
    END IF;
  END IF;

  -- 4. Legacy no-date fallback: newest listing. Unaffected by the year
  -- boundary — there is no order_date to compare a year against.
  IF p_order_date IS NULL AND (v_valid_sku OR v_valid_asin) THEN
    SELECT CASE
      WHEN COALESCE(cl.amount,0) > 0 THEN cl.amount
      WHEN COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0 THEN cl.cost / cl.units
      ELSE NULL
    END INTO v_cost
    FROM public.created_listings cl
    WHERE cl.user_id = p_user_id
      AND ((v_valid_sku AND cl.sku = p_sku) OR (v_valid_asin AND cl.asin = p_asin))
      AND (COALESCE(cl.amount,0) > 0 OR (COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0))
    ORDER BY COALESCE(cl.date_created, cl.created_at::date) DESC, cl.created_at DESC
    LIMIT 1;
    IF COALESCE(v_cost,0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'listingsFallback'::text;
      RETURN;
    END IF;
  END IF;

  -- 5. Current inventory final fallback. Unaffected — this is the
  -- destination a same-year miss now falls through to.
  SELECT CASE
    WHEN COALESCE(i.amount,0) > 0 THEN i.amount
    WHEN COALESCE(i.cost,0) > 0 AND COALESCE(i.units,0) > 0 THEN i.cost / i.units
    ELSE NULL
  END INTO v_cost
  FROM public.inventory i
  WHERE i.user_id = p_user_id
    AND ((v_valid_sku AND i.sku = p_sku) OR (v_valid_asin AND i.asin = p_asin))
  LIMIT 1;
  IF COALESCE(v_cost,0) > 0 THEN
    RETURN QUERY SELECT round(v_cost::numeric, 2), 'inventoryFallback'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 0::numeric, 'unresolved'::text;
END;
$function$;
