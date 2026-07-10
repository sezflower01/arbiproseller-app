
UPDATE public.business_health_issues
SET affected_entities = COALESCE((
  SELECT jsonb_agg(e ORDER BY e->>'order_id', e->>'asin')
  FROM (
    SELECT DISTINCT ON (
      LOWER(COALESCE(e->>'order_id','')),
      LOWER(COALESCE(e->>'asin','')),
      LOWER(COALESCE(e->>'marketplace',''))
    ) e
    FROM jsonb_array_elements(affected_entities) e
  ) d
), '[]'::jsonb)
WHERE jsonb_typeof(affected_entities) = 'array'
  AND jsonb_array_length(affected_entities) > 1;
