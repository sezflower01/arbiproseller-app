CREATE OR REPLACE FUNCTION public.propagate_ship_to_hash_to_refunds(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  WITH upd AS (
    UPDATE public.sales_orders r
       SET ship_to_hash = b.ship_to_hash
      FROM public.sales_orders b
     WHERE r.user_id = p_user_id
       AND b.user_id = p_user_id
       AND r.ship_to_hash IS NULL
       AND b.ship_to_hash IS NOT NULL
       AND r.order_id LIKE '%-REFUND%'
       AND b.order_id = split_part(r.order_id, '-REFUND', 1)
    RETURNING 1
  )
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION public.propagate_ship_to_hash_to_refunds(uuid) TO service_role;