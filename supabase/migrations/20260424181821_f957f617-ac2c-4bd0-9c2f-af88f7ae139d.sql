-- ================================================================
-- Phase 1: Shipment Accounting
-- ================================================================
-- 1) Manual additional costs per shipment (prep, freight, supplies, etc.)
-- 2) RPC to compute per-shipment + monthly accounting totals
--    COGS rule: created_listings.amount FIRST → fallback sales_orders.unit_cost
--    Never duplicate COGS storage in shipment tables
-- 3) RPC to hard-delete dead inventory rows (zero-stock + terminal status)
--    Never touches fba_shipment_items (history is preserved forever)
-- ================================================================

-- ---------- Manual cost overlay table ----------
CREATE TABLE IF NOT EXISTS public.shipment_costs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  shipment_id text NOT NULL,
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  note        text,
  cost_date   date NOT NULL DEFAULT CURRENT_DATE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_costs_user_shipment
  ON public.shipment_costs (user_id, shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_costs_user_date
  ON public.shipment_costs (user_id, cost_date);

ALTER TABLE public.shipment_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own shipment costs" ON public.shipment_costs;
CREATE POLICY "Users view own shipment costs"
  ON public.shipment_costs FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own shipment costs" ON public.shipment_costs;
CREATE POLICY "Users insert own shipment costs"
  ON public.shipment_costs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own shipment costs" ON public.shipment_costs;
CREATE POLICY "Users update own shipment costs"
  ON public.shipment_costs FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own shipment costs" ON public.shipment_costs;
CREATE POLICY "Users delete own shipment costs"
  ON public.shipment_costs FOR DELETE
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS trg_shipment_costs_updated_at ON public.shipment_costs;
CREATE TRIGGER trg_shipment_costs_updated_at
  BEFORE UPDATE ON public.shipment_costs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------- Per-shipment accounting RPC ----------
CREATE OR REPLACE FUNCTION public.get_shipment_accounting_period(
  p_start date,
  p_end   date
)
RETURNS TABLE (
  shipment_id        text,
  shipment_name      text,
  shipment_status    text,
  shipment_date      date,
  units_shipped      bigint,
  units_received     bigint,
  cogs               numeric,
  amazon_inbound_fee numeric,
  manual_cost        numeric,
  total_cost         numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT
      sh.shipment_id,
      sh.shipment_name,
      sh.shipment_status,
      sh.created_at::date AS shipment_date
    FROM public.fba_shipments sh
    WHERE sh.user_id = auth.uid()
      AND sh.created_at::date >= p_start
      AND sh.created_at::date <  p_end
  ),
  -- Latest unit_cost per ASIN from created_listings (Contract A)
  -- amount = UNIT cost; fallback to cost/units when amount is missing
  cl_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        WHEN COALESCE(amount, -1) >= 0 THEN amount
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        ELSE NULL
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL AND asin <> ''
    ORDER BY asin, updated_at DESC
  ),
  -- Fallback: latest sales_orders.unit_cost per ASIN
  so_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      unit_cost
    FROM public.sales_orders
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL AND asin <> ''
      AND COALESCE(unit_cost, 0) > 0
    ORDER BY asin, order_date DESC
  ),
  items AS (
    SELECT
      i.shipment_id,
      SUM(COALESCE(i.quantity_shipped, 0))::bigint  AS units_shipped,
      SUM(COALESCE(i.quantity_received, 0))::bigint AS units_received,
      SUM(
        COALESCE(i.quantity_shipped, 0) *
        COALESCE(cl.unit_cost, so.unit_cost, 0)
      )::numeric AS cogs
    FROM public.fba_shipment_items i
    LEFT JOIN cl_unit_cost cl ON cl.asin = i.asin
    LEFT JOIN so_unit_cost so ON so.asin = i.asin
    WHERE i.user_id = auth.uid()
      AND i.shipment_id IN (SELECT shipment_id FROM s)
    GROUP BY i.shipment_id
  ),
  fees AS (
    SELECT
      f.shipment_id,
      SUM(ABS(COALESCE(f.fee_amount, 0)))::numeric AS amazon_inbound_fee
    FROM public.fba_inbound_fees f
    WHERE f.user_id = auth.uid()
      AND f.shipment_id IN (SELECT shipment_id FROM s)
    GROUP BY f.shipment_id
  ),
  manual AS (
    SELECT
      c.shipment_id,
      SUM(COALESCE(c.amount, 0))::numeric AS manual_cost
    FROM public.shipment_costs c
    WHERE c.user_id = auth.uid()
      AND c.shipment_id IN (SELECT shipment_id FROM s)
    GROUP BY c.shipment_id
  )
  SELECT
    s.shipment_id,
    s.shipment_name,
    s.shipment_status,
    s.shipment_date,
    COALESCE(items.units_shipped, 0)             AS units_shipped,
    COALESCE(items.units_received, 0)            AS units_received,
    COALESCE(items.cogs, 0)                      AS cogs,
    COALESCE(fees.amazon_inbound_fee, 0)         AS amazon_inbound_fee,
    COALESCE(manual.manual_cost, 0)              AS manual_cost,
    COALESCE(items.cogs, 0)
      + COALESCE(fees.amazon_inbound_fee, 0)
      + COALESCE(manual.manual_cost, 0)          AS total_cost
  FROM s
  LEFT JOIN items  ON items.shipment_id  = s.shipment_id
  LEFT JOIN fees   ON fees.shipment_id   = s.shipment_id
  LEFT JOIN manual ON manual.shipment_id = s.shipment_id
  ORDER BY s.shipment_date DESC, s.shipment_id;
$$;

-- ---------- Admin-only ghost cleanup RPC ----------
-- Hard-deletes inventory rows that are zero-stock AND have terminal listing status.
-- NEVER touches fba_shipment_items, fba_shipments, or fba_inbound_fees.
CREATE OR REPLACE FUNCTION public.admin_clean_dead_inventory()
RETURNS TABLE(deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Access denied: admin only';
  END IF;

  WITH del AS (
    DELETE FROM public.inventory
    WHERE user_id = auth.uid()
      AND COALESCE(available, 0) = 0
      AND COALESCE(reserved, 0)  = 0
      AND COALESCE(inbound, 0)   = 0
      AND UPPER(COALESCE(listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED', 'INACTIVE')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM del;

  deleted_count := v_count;
  RETURN NEXT;
END;
$$;