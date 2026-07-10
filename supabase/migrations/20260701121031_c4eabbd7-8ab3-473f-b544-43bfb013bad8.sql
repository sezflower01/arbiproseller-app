CREATE OR REPLACE FUNCTION public.bulk_apply_ship_to_hash(p_user_id uuid, p_pairs jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  WITH pairs AS (
    SELECT (elem->>'oid')::text AS oid, (elem->>'h')::text AS h
      FROM jsonb_array_elements(p_pairs) elem
  ), upd AS (
    UPDATE public.sales_orders s
       SET ship_to_hash = p.h
      FROM pairs p
     WHERE s.user_id = p_user_id
       AND s.order_id = p.oid
       AND (s.ship_to_hash IS DISTINCT FROM p.h)
    RETURNING 1
  )
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION public.bulk_apply_ship_to_hash(uuid, jsonb) TO service_role;