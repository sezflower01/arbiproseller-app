-- Reorder unified COGS precedence so the newest created_listings COG wins
-- over any stale sales_orders.unit_cost snapshot. User requirement: editing
-- a listing's COG must propagate to Live Sales / Sales Report / P&L
-- immediately. Manual override (asin_cost_overrides) still wins above all.
--
-- New precedence:
--   1. asin_cost_overrides (date-aware)
--   2. created_listings newest by date_created (ASIN)
--   3. sales_orders.unit_cost snapshot
--   4. inventory.cost (ASIN)
--   5. SKU fallbacks (created_listings then inventory)
--   6. unresolved

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
  -- 1. date-aware manual override (explicit user input always wins)
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

  -- 2. created_listings newest by date_created (ASIN) — overrides stale snapshot
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

  -- 3. sales_orders.unit_cost snapshot (accounting fallback)
  IF COALESCE(p_snapshot_unit_cost, 0) > 0 THEN
    RETURN QUERY SELECT p_snapshot_unit_cost::numeric, 'salesOrders'::text;
    RETURN;
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
