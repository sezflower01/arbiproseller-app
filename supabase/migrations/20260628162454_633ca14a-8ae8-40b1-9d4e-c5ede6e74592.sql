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
  v_valid_asin boolean := p_asin IS NOT NULL AND p_asin <> '' AND p_asin <> 'PENDING' AND p_asin <> 'UNKNOWN';
  v_valid_sku boolean := p_sku IS NOT NULL AND btrim(p_sku) <> '';
BEGIN
  -- 1. Locked order-level snapshot always wins. This is the historical COGS lock:
  -- later purchases / inventory edits must not rewrite old sales profit.
  IF COALESCE(p_snapshot_unit_cost, 0) > 0 THEN
    RETURN QUERY SELECT round(p_snapshot_unit_cost::numeric, 2), 'salesOrders'::text;
    RETURN;
  END IF;

  -- 2. Date-aware manual override for rows that do not yet have a locked snapshot.
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

  -- 3. Purchase batch / lot history before the order date (SKU-first, then ASIN).
  -- created_listing_purchases.unit_cost is already per-unit.
  IF p_order_date IS NOT NULL AND (v_valid_asin OR v_valid_sku) THEN
    SELECT p.unit_cost INTO v_cost
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
    ORDER BY
      CASE WHEN v_valid_sku AND cl.sku = p_sku THEN 0 ELSE 1 END,
      p.purchase_date DESC,
      p.created_at DESC,
      p.id DESC
    LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'purchaseBatch'::text;
      RETURN;
    END IF;
  END IF;

  -- 4. Date-aware created_listings fallback before the order date (SKU-first, then ASIN).
  -- Contract A: amount = UNIT cost, cost = TOTAL batch cost.
  IF p_order_date IS NOT NULL AND (v_valid_asin OR v_valid_sku) THEN
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
      AND COALESCE(cl.date_created, cl.created_at::date) <= p_order_date
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
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'listingsHistorical'::text;
      RETURN;
    END IF;
  END IF;

  -- 5. Legacy fallback for rows without an order date: newest listing, still SKU-first.
  IF p_order_date IS NULL AND (v_valid_asin OR v_valid_sku) THEN
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

  -- 6. Current inventory cost is only a last-resort low-confidence fallback.
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

CREATE OR REPLACE FUNCTION public.get_cogs_for_range(p_start date, p_end date)
RETURNS TABLE(total_cogs numeric, units_sold bigint, orders_with_cost bigint, total_orders bigint, cogs_by_source jsonb, units_by_source jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      s.asin,
      COALESCE(s.seller_sku, s.sku) AS sku,
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
    SELECT b.qty, r.unit_cost, r.source
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_user, b.asin, b.sku, b.order_date, b.snapshot_cost) r
  ),
  by_source AS (
    SELECT
      source,
      SUM(unit_cost * qty)::numeric AS total_per_source,
      SUM(qty)::bigint AS units_per_source,
      COUNT(*) FILTER (WHERE unit_cost > 0)::bigint AS orders_with_source_cost,
      COUNT(*)::bigint AS orders_per_source
    FROM resolved
    GROUP BY source
  )
  SELECT
    COALESCE(SUM(total_per_source), 0)::numeric AS total_cogs,
    COALESCE((SELECT SUM(qty) FROM resolved), 0)::bigint AS units_sold,
    COALESCE(SUM(orders_with_source_cost), 0)::bigint AS orders_with_cost,
    COALESCE(SUM(orders_per_source), 0)::bigint AS total_orders,
    COALESCE(jsonb_object_agg(source, total_per_source), '{}'::jsonb) AS cogs_by_source,
    COALESCE(jsonb_object_agg(source, units_per_source), '{}'::jsonb) AS units_by_source
  FROM by_source;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_cogs_for_range(date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_sellerboard_period_totals(start_ts text, end_ts text)
RETURNS TABLE(sales numeric, refunds numeric, total_fees numeric, unique_orders bigint, refund_count bigint, row_count bigint, total_units numeric, cogs numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  base AS (
    SELECT *,
      COALESCE(
        NULLIF(COALESCE(sold_price, 0), 0),
        NULLIF(COALESCE(estimated_price, 0), 0),
        0
      ) AS effective_price
    FROM public.sales_orders s
    CROSS JOIN bounds b
    WHERE s.user_id = auth.uid()
      AND s.order_date >= b.start_d
      AND s.order_date < b.end_d
      AND NOT s.order_id LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
  ),
  cogs_calc AS (
    SELECT SUM(r.unit_cost * COALESCE(b.quantity, 1)) AS total_cogs
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(
      auth.uid(),
      b.asin,
      COALESCE(b.seller_sku, b.sku),
      b.order_date,
      b.unit_cost
    ) r
  )
  SELECT
    COALESCE(SUM(
      CASE WHEN COALESCE(total_sale_amount, 0) > 0 THEN total_sale_amount
           WHEN effective_price > 0 THEN effective_price * quantity
           ELSE 0
      END
    ), 0) AS sales,
    COALESCE(SUM(COALESCE(refund_amount, 0)), 0) AS refunds,
    COALESCE(SUM(COALESCE(total_fees, 0)), 0) AS total_fees,
    COALESCE(COUNT(DISTINCT NULLIF(order_id, '')), 0) AS unique_orders,
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(refund_amount, 0) > 0), 0) AS refund_count,
    COALESCE(COUNT(*), 0) AS row_count,
    COALESCE(SUM(COALESCE(quantity, 1)), 0) AS total_units,
    COALESCE((SELECT total_cogs FROM cogs_calc), 0) AS cogs
  FROM base;
$function$;

GRANT EXECUTE ON FUNCTION public.get_sellerboard_period_totals(text, text) TO authenticated, service_role;