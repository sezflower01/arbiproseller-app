CREATE OR REPLACE FUNCTION public.resolve_unit_cost_v1(
  p_user_id uuid,
  p_asin text,
  p_sku text,
  p_order_date date,
  p_snapshot_unit_cost numeric DEFAULT NULL::numeric
)
RETURNS TABLE(unit_cost numeric, source text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cost numeric;
  v_source text;
  v_valid_asin boolean := p_asin IS NOT NULL AND btrim(p_asin) <> '' AND p_asin <> 'PENDING' AND p_asin <> 'UNKNOWN';
  v_valid_sku boolean := p_sku IS NOT NULL AND btrim(p_sku) <> '';
BEGIN
  -- 1. Locked/snapshotted order cost always wins. This is the historical accounting lock.
  IF COALESCE(p_snapshot_unit_cost, 0) > 0 THEN
    RETURN QUERY SELECT round(p_snapshot_unit_cost::numeric, 2), 'salesOrders'::text;
    RETURN;
  END IF;

  -- 2. Date-aware manual override for rows not yet locked.
  IF v_valid_asin AND p_order_date IS NOT NULL THEN
    SELECT o.unit_cost INTO v_cost
    FROM public.asin_cost_overrides o
    WHERE o.user_id = p_user_id
      AND o.asin = p_asin
      AND o.effective_from <= p_order_date
    ORDER BY o.effective_from DESC
    LIMIT 1;

    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'manualOverride'::text;
      RETURN;
    END IF;
  END IF;

  -- 3. Date-aware historical cost event before the order date.
  -- Purchase records and created listing rows are one timeline: an ancient purchase
  -- batch must not outrank a newer listing cost entered before the sale.
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
      WHERE p.user_id = p_user_id
        AND cl.user_id = p_user_id
        AND p.unit_cost > 0
        AND p.purchase_date < (p_order_date::timestamp with time zone + interval '1 day')
        AND (
          (v_valid_sku AND cl.sku = p_sku)
          OR (v_valid_asin AND cl.asin = p_asin)
        )

      UNION ALL

      SELECT
        CASE
          WHEN COALESCE(cl.amount, 0) > 0 THEN cl.amount
          WHEN COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0 THEN cl.cost / cl.units
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
        AND (
          (v_valid_sku AND cl.sku = p_sku)
          OR (v_valid_asin AND cl.asin = p_asin)
        )
        AND COALESCE(cl.date_created, cl.created_at::date) <= p_order_date
        AND (
          COALESCE(cl.amount, 0) > 0
          OR (COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0)
        )
    )
    SELECT c.candidate_cost, c.candidate_source
      INTO v_cost, v_source
    FROM cost_candidates c
    WHERE COALESCE(c.candidate_cost, 0) > 0
    ORDER BY
      c.match_rank ASC,
      c.cost_ts DESC NULLS LAST,
      c.created_ts DESC NULLS LAST,
      c.tie_rank ASC,
      c.stable_id DESC
    LIMIT 1;

    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), COALESCE(v_source, 'listingsHistorical')::text;
      RETURN;
    END IF;
  END IF;

  -- 4. Legacy no-date fallback: newest listing, still SKU-first. Used only when order_date is missing.
  IF p_order_date IS NULL AND (v_valid_sku OR v_valid_asin) THEN
    SELECT CASE
      WHEN COALESCE(cl.amount, 0) > 0 THEN cl.amount
      WHEN COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0 THEN cl.cost / cl.units
      ELSE NULL
    END INTO v_cost
    FROM public.created_listings cl
    WHERE cl.user_id = p_user_id
      AND (
        (v_valid_sku AND cl.sku = p_sku)
        OR (v_valid_asin AND cl.asin = p_asin)
      )
      AND (
        COALESCE(cl.amount, 0) > 0
        OR (COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0)
      )
    ORDER BY
      CASE WHEN v_valid_sku AND cl.sku = p_sku THEN 0 ELSE 1 END,
      cl.date_created DESC NULLS LAST,
      cl.created_at DESC NULLS LAST,
      cl.id DESC
    LIMIT 1;

    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'listingsFallback'::text;
      RETURN;
    END IF;
  END IF;

  -- 5. Current inventory is only the final, low-confidence fallback.
  IF v_valid_sku THEN
    SELECT CASE
      WHEN COALESCE(i.cost, 0) > 0 THEN i.cost
      WHEN COALESCE(i.amount, 0) > 0 AND COALESCE(i.units, 0) > 0 THEN i.amount / i.units
      ELSE NULL
    END INTO v_cost
    FROM public.inventory i
    WHERE i.user_id = p_user_id
      AND i.sku = p_sku
      AND (
        COALESCE(i.cost, 0) > 0
        OR (COALESCE(i.amount, 0) > 0 AND COALESCE(i.units, 0) > 0)
      )
    ORDER BY i.updated_at DESC NULLS LAST
    LIMIT 1;

    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'inventoryFallback'::text;
      RETURN;
    END IF;
  END IF;

  IF v_valid_asin THEN
    SELECT CASE
      WHEN COALESCE(i.cost, 0) > 0 THEN i.cost
      WHEN COALESCE(i.amount, 0) > 0 AND COALESCE(i.units, 0) > 0 THEN i.amount / i.units
      ELSE NULL
    END INTO v_cost
    FROM public.inventory i
    WHERE i.user_id = p_user_id
      AND i.asin = p_asin
      AND (
        COALESCE(i.cost, 0) > 0
        OR (COALESCE(i.amount, 0) > 0 AND COALESCE(i.units, 0) > 0)
      )
    ORDER BY i.updated_at DESC NULLS LAST
    LIMIT 1;

    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'inventoryFallback'::text;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT 0::numeric, 'unresolved'::text;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_unit_cost_v1(uuid, text, text, date, numeric) TO authenticated, service_role;