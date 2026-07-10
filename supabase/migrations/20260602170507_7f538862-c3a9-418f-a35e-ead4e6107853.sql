CREATE OR REPLACE FUNCTION public.admin_reset_pg_stat_statements()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  caller uuid := auth.uid();
BEGIN
  IF caller IS NULL OR NOT public.has_role(caller, 'admin') THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  PERFORM extensions.pg_stat_statements_reset();

  RETURN jsonb_build_object(
    'ok', true,
    'reset_at', now(),
    'reset_by', caller
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reset_pg_stat_statements() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reset_pg_stat_statements() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reset_pg_stat_statements() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_pg_stat_statements() TO service_role;

COMMENT ON FUNCTION public.admin_reset_pg_stat_statements() IS
  'Admin-only one-shot reset of pg_stat_statements for CPU validation snapshots. Drop after use.';