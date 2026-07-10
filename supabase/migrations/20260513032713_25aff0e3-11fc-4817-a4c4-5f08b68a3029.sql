-- Admin diagnostics RPC: estimated row counts for monitored tables.
-- Uses pg_class.reltuples — extremely fast at scale, suitable for live admin views.
CREATE OR REPLACE FUNCTION public.admin_table_size_estimates(table_names text[])
RETURNS TABLE(table_name text, estimated_rows bigint, total_bytes bigint, last_vacuum timestamptz, last_analyze timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    c.relname::text,
    GREATEST(c.reltuples, 0)::bigint AS estimated_rows,
    pg_total_relation_size(c.oid)::bigint AS total_bytes,
    s.last_vacuum,
    s.last_analyze
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname = ANY(table_names)
    AND public.has_role(auth.uid(), 'admin'::public.app_role);
$$;

REVOKE ALL ON FUNCTION public.admin_table_size_estimates(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_table_size_estimates(text[]) TO authenticated;