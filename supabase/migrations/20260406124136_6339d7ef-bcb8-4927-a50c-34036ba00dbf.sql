CREATE OR REPLACE FUNCTION public.run_analytics_query(query_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  clean_query text;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'admin') OR
    public.has_role(auth.uid(), 'monitor')
  ) THEN
    RAISE EXCEPTION 'Access denied: requires admin or monitor role';
  END IF;

  clean_query := TRIM(query_text);
  IF NOT (clean_query ILIKE 'SELECT%' OR clean_query ILIKE 'WITH%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- Use word-boundary regex to avoid false positives like created_at matching CREATE
  IF clean_query ~* '\m(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\M' THEN
    RAISE EXCEPTION 'Write operations are not allowed';
  END IF;

  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || clean_query || ') t' INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$function$;