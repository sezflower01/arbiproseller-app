-- list_shipments_missing_items: returns shipments owned by the caller that have
-- ZERO rows in fba_shipment_items. The "Repair Missing Items" tool uses this
-- to pick targets for re-pulling items from Amazon SP-API.
--
-- Strictly read-only and SECURITY DEFINER so it can use auth.uid() consistently.
CREATE OR REPLACE FUNCTION public.list_shipments_missing_items(p_limit integer DEFAULT 25)
RETURNS TABLE (
  shipment_id text,
  shipment_name text,
  shipment_status text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sh.shipment_id,
    sh.shipment_name,
    sh.shipment_status,
    sh.created_at
  FROM public.fba_shipments sh
  WHERE sh.user_id = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.fba_shipment_items i
      WHERE i.shipment_id = sh.shipment_id
        AND i.user_id = sh.user_id
    )
  ORDER BY sh.created_at DESC
  LIMIT GREATEST(p_limit, 1);
$$;

-- Lightweight count helper for the UI badge.
CREATE OR REPLACE FUNCTION public.count_shipments_missing_items()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::int
  FROM public.fba_shipments sh
  WHERE sh.user_id = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.fba_shipment_items i
      WHERE i.shipment_id = sh.shipment_id
        AND i.user_id = sh.user_id
    );
$$;

GRANT EXECUTE ON FUNCTION public.list_shipments_missing_items(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_shipments_missing_items() TO authenticated;