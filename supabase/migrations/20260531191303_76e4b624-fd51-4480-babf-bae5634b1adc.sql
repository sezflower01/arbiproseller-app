-- =====================================================================
-- Unified COGS engine
-- One precedence, used by P&L (retrieve + yearly + export) AND mirrored
-- by client-side resolveUnitCost.ts for Live Sales / Sales Report.
-- =====================================================================

-- Per-row resolver. STABLE + SECURITY DEFINER so it can run inside RLS
-- contexts. Returns (unit_cost, source).
CREATE OR REPLACE FUNCTION public.resolve_unit_cost_v1(
  p_user_id uuid,
  p_asin text,
  p_sku text,
  p_order_date date,
  p_snapshot_unit_cost numeric DEFAULT NULL
)
RETURNS TABLE(unit_cost numeric, source text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost numeric;
  v_valid_asin boolean := p_asin IS NOT NULL AND p_asin <> '' AND p_asin <> 'PENDING' AND p_asin <> 'UNKNOWN';
BEGIN
  -- 1. snapshot wins
  IF COALESCE(p_snapshot_unit_cost, 0) > 0 THEN
    RETURN QUERY SELECT p_snapshot_unit_cost::numeric, 'salesOrders'::text;
    RETURN;
  END IF;

  -- 2. date-aware manual override
  IF v_valid_asin AND p_order_date IS NOT NULL THEN
    SELECT o.unit_cost INTO v_cost
    FROM public.asin_cost_overrides o
    WHERE o.user_id = p_user_id
      AND o.asin = p_asin
      AND o.effective_from <= p_order_date
    ORDER BY o.effective_from DESC
    LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT v_cost, 'manualOverride'::text;
      RETURN;
    END IF;
  END IF;

  -- 3. created_listings newest by date_created DESC (ASIN)
  IF v_valid_asin THEN
    SELECT CASE
      WHEN COALESCE(cl.amount, -1) > 0 THEN cl.amount
      WHEN COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0 THEN cl.cost / cl.units
      ELSE NULL
    END INTO v_cost
    FROM public.created_listings cl
    WHERE cl.user_id = p_user_id
      AND cl.asin = p_asin
      AND (
        COALESCE(cl.amount, 0) > 0
        OR (COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0)
      )
    ORDER BY cl.date_created DESC NULLS LAST, cl.created_at DESC NULLS LAST, cl.id DESC
    LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT v_cost, 'listingsFallback'::text;
      RETURN;
    END IF;
  END IF;

  -- 4. inventory.cost (per-unit) by ASIN
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
      RETURN QUERY SELECT v_cost, 'inventoryFallback'::text;
      RETURN;
    END IF;
  END IF;

  -- 5a. SKU fallback — created_listings
  IF p_sku IS NOT NULL AND p_sku <> '' THEN
    SELECT CASE
      WHEN COALESCE(cl.amount, -1) > 0 THEN cl.amount
      WHEN COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0 THEN cl.cost / cl.units
      ELSE NULL
    END INTO v_cost
    FROM public.created_listings cl
    WHERE cl.user_id = p_user_id
      AND cl.sku = p_sku
      AND (
        COALESCE(cl.amount, 0) > 0
        OR (COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0)
      )
    ORDER BY cl.date_created DESC NULLS LAST, cl.created_at DESC NULLS LAST, cl.id DESC
    LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT v_cost, 'listingsFallback'::text;
      RETURN;
    END IF;

    -- 5b. SKU fallback — inventory
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
      RETURN QUERY SELECT v_cost, 'inventoryFallback'::text;
      RETURN;
    END IF;
  END IF;

  -- 6. unresolved
  RETURN QUERY SELECT 0::numeric, 'unresolved'::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_unit_cost_v1(uuid, text, text, date, numeric) TO authenticated, service_role;

-- =====================================================================
-- COGS aggregation for an arbitrary date range (used by P&L Retrieve COGS).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_cogs_for_range(
  p_start date,
  p_end date
)
RETURNS TABLE(
  total_cogs numeric,
  units_sold bigint,
  orders_with_cost bigint,
  total_orders bigint,
  cogs_by_source jsonb,
  units_by_source jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      s.asin,
      s.sku,
      s.order_date,
      s.unit_cost AS snapshot_cost,
      COALESCE(s.quantity, 1) AS qty
    FROM public.sales_orders s
    WHERE s.user_id = v_user
      AND s.order_date >= p_start
      AND s.order_date <= p_end
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
  ),
  resolved AS (
    SELECT
      b.qty,
      r.unit_cost,
      r.source
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_user, b.asin, b.sku, b.order_date, b.snapshot_cost) r
  )
  SELECT
    COALESCE(SUM(r.unit_cost * r.qty), 0)::numeric                                   AS total_cogs,
    COALESCE(SUM(r.qty), 0)::bigint                                                  AS units_sold,
    COALESCE(SUM(CASE WHEN r.unit_cost > 0 THEN 1 ELSE 0 END), 0)::bigint            AS orders_with_cost,
    COUNT(*)::bigint                                                                 AS total_orders,
    COALESCE(
      jsonb_object_agg(r.source, total_per_source),
      '{}'::jsonb
    ) AS cogs_by_source,
    COALESCE(
      jsonb_object_agg(r.source, units_per_source),
      '{}'::jsonb
    ) AS units_by_source
  FROM (
    SELECT
      source,
      SUM(unit_cost * qty)::numeric AS total_per_source,
      SUM(qty)::bigint              AS units_per_source,
      qty,
      unit_cost
    FROM resolved
    GROUP BY source, qty, unit_cost
  ) r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cogs_for_range(date, date) TO authenticated, service_role;

-- =====================================================================
-- Rewritten monthly COGS (yearly view + CSV export). Same resolver.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_monthly_cogs(p_year integer)
RETURNS TABLE(
  month_num integer,
  cogs numeric,
  units_sold bigint,
  units_with_cost bigint,
  units_missing_cost bigint,
  orders_missing_cost bigint,
  asins_missing_cost bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_start date := make_date(p_year, 1, 1);
  v_end   date := make_date(p_year + 1, 1, 1);
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      s.order_id,
      s.asin,
      s.sku,
      s.order_date,
      s.unit_cost AS snapshot_cost,
      COALESCE(s.quantity, 1) AS qty,
      EXTRACT(MONTH FROM s.order_date)::int AS m
    FROM public.sales_orders s
    WHERE s.user_id = v_user
      AND s.order_date >= v_start
      AND s.order_date <  v_end
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
  ),
  resolved AS (
    SELECT
      b.m, b.order_id, b.asin, b.qty,
      r.unit_cost AS effective_unit_cost
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_user, b.asin, b.sku, b.order_date, b.snapshot_cost) r
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    COALESCE(SUM(e.effective_unit_cost * e.qty), 0)::numeric                                            AS cogs,
    COALESCE(SUM(e.qty), 0)::bigint                                                                     AS units_sold,
    COALESCE(SUM(CASE WHEN e.effective_unit_cost > 0 THEN e.qty ELSE 0 END), 0)::bigint                 AS units_with_cost,
    COALESCE(SUM(CASE WHEN e.effective_unit_cost > 0 THEN 0 ELSE e.qty END), 0)::bigint                 AS units_missing_cost,
    COALESCE(COUNT(DISTINCT CASE WHEN e.effective_unit_cost > 0 THEN NULL ELSE e.order_id END), 0)::bigint AS orders_missing_cost,
    COALESCE(COUNT(DISTINCT CASE WHEN e.effective_unit_cost > 0 THEN NULL ELSE NULLIF(e.asin, '') END), 0)::bigint AS asins_missing_cost
  FROM months
  LEFT JOIN resolved e ON e.m = months.m
  GROUP BY months.m
  ORDER BY months.m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_monthly_cogs(integer) TO authenticated, service_role;