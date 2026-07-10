CREATE OR REPLACE FUNCTION public.delete_all_keepa_simple_products()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  DELETE FROM public.keepa_simple_products;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;