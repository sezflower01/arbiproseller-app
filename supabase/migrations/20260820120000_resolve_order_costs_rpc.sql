-- Per-order resolved cost, using the SAME resolver the P&L uses.
--
-- WHY. The Orders Cost Editor decided "missing cost" from
-- sales_orders.unit_cost alone, while COGS (get_monthly_cogs) resolves through
-- resolve_unit_cost_v1: snapshot -> manual override -> cost_history ->
-- purchase batches / created_listings -> inventory. Two different definitions of
-- "has a cost", so the editor reported orders as missing that the P&L had
-- already costed correctly.
--
-- The visible cost of that: "Backfill from Library" writes a value into
-- sales_orders.unit_cost, which silences the editor -- but COGS already had the
-- number, so the backfill changed no financial figure. It looked like a fix that
-- never stuck, because there was nothing to fix.
--
-- Measured 2026-08-20 on this account: of all 2026 non-refund orders with no
-- snapshot cost, only 8 orders / 8 units were genuinely unresolvable, and every
-- one was a PENDING or UNKNOWN ASIN -- an identity problem for "Fetch from
-- Amazon", not a cost problem.
--
-- Returns the source as well as the number, so the UI can say WHERE a cost came
-- from. A cost resolved from inventoryFallback deserves less trust than a
-- locked sale-time snapshot, and hiding that distinction is how "it has a cost"
-- turns into "it has the right cost".
--
-- STABLE + SECURITY DEFINER + auth.uid(), matching get_monthly_cogs: the
-- resolver reads several tables the caller may not hold direct grants on, and
-- scoping by auth.uid() keeps a definer function from becoming a way to read
-- another account's costs.

CREATE OR REPLACE FUNCTION public.resolve_order_costs_v1(
  p_start date,
  p_end   date
)
RETURNS TABLE(
  order_row_id uuid,
  resolved_unit_cost numeric,
  resolved_source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT s.id, r.unit_cost, r.source
  FROM public.sales_orders s
  CROSS JOIN LATERAL public.resolve_unit_cost_v1(
    v_user, s.asin, s.sku, s.order_date, s.unit_cost
  ) r
  WHERE s.user_id = v_user
    AND s.order_date >= p_start
    AND s.order_date <= p_end;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_order_costs_v1(date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_order_costs_v1(date, date) TO authenticated;
