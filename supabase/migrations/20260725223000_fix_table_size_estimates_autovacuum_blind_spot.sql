-- admin_table_size_estimates only read last_vacuum/last_analyze (manual runs),
-- ignoring last_autovacuum/last_autoanalyze -- so the Cron Diagnostics page
-- reported "never analyzed" for tables that autovacuum was maintaining
-- correctly the whole time (confirmed: inventory, repricer_assignments,
-- sales_orders, cron_run_history all have recent autovacuum/autoanalyze
-- activity). Report whichever (manual or auto) happened most recently.

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
    GREATEST(s.last_vacuum, s.last_autovacuum) AS last_vacuum,
    GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyze
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname = ANY(table_names)
    AND public.has_role(auth.uid(), 'admin'::public.app_role);
$$;
