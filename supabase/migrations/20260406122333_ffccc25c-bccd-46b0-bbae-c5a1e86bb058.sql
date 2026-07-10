CREATE OR REPLACE FUNCTION public.run_analytics_query(query_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  IF clean_query ILIKE '%INSERT%' OR clean_query ILIKE '%UPDATE%' OR
     clean_query ILIKE '%DELETE%' OR clean_query ILIKE '%DROP%' OR
     clean_query ILIKE '%ALTER%' OR clean_query ILIKE '%TRUNCATE%' OR
     clean_query ILIKE '%CREATE%' OR clean_query ILIKE '%GRANT%' THEN
    RAISE EXCEPTION 'Write operations are not allowed';
  END IF;

  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || clean_query || ') t' INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;