-- resolve_unit_cost_v1 tier 5 (inventory.cost final fallback) had Contract A
-- backwards: it preferred inventory.amount (the TOTAL stock value) and
-- returned it AS-IS as a unit cost, only falling back to cost/units (which
-- divides an already-per-unit value again) when amount was missing. Per
-- Contract A (src/lib/cost-contract.ts, and its Deno mirror
-- _shared/cost-contract.ts's getInventoryUnitCostSafe — both already used
-- correctly everywhere else in the app): inventory.cost IS the unit cost;
-- inventory.amount is the TOTAL value and must be divided by units to get a
-- per-unit number. Confirmed on real data (ASIN B00JNR7928,
-- cost=$4.637333, amount=$70.10, units=138): the old logic returned $70.10
-- as a "unit cost"; the fix returns $4.64 (i.e. inventory.cost directly).
--
-- This now matters more since the year-boundary fix (previous migration)
-- routes more orders into this exact fallback tier whenever nothing exists
-- yet in the current calendar year.
--
-- Only tier 5 changes; every other tier is identical to the previous
-- migration (20260716124500_resolve_unit_cost_v1_year_boundary.sql).
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

  -- 5. Current inventory final fallback. Contract A: inventory.cost IS the
  -- unit cost (prefer it directly); inventory.amount is the TOTAL stock
  -- value and must be divided by units to get a per-unit number.
  SELECT CASE
    WHEN COALESCE(i.cost,0) > 0 THEN i.cost
    WHEN COALESCE(i.amount,0) > 0 AND COALESCE(i.units,0) > 0 THEN i.amount / i.units
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
