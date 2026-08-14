-- Confirmed via direct timing: repricer_asin_raises with an unbounded
-- asin = ANY(236-element array) over repricer_price_actions timed out even
-- run alone (not concurrently with anything else). Apply the same LIMIT +
-- ORDER BY created_at DESC safety valve repricer_rule_perf_raises already
-- uses account-wide, so the query can stop early via
-- idx_repricer_price_actions_user_created instead of fully resolving the
-- asin filter against the whole table.
DROP FUNCTION IF EXISTS public.repricer_asin_raises(uuid, timestamptz, text[]);

CREATE FUNCTION public.repricer_asin_raises(p_user_id uuid, p_since timestamptz, p_asins text[], p_limit int DEFAULT 3000)
RETURNS TABLE(
  asin text,
  sku text,
  marketplace text,
  old_price numeric,
  new_price numeric,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT asin, sku, marketplace, old_price, new_price, created_at
  FROM (
    SELECT asin, sku, marketplace, old_price, new_price, created_at
    FROM repricer_price_actions
    WHERE user_id = p_user_id
      AND created_at >= p_since
      AND new_price IS NOT NULL
      AND old_price IS NOT NULL
      AND new_price > old_price
    ORDER BY created_at DESC
    LIMIT p_limit
  ) recent
  WHERE asin = ANY(p_asins)
  ORDER BY created_at ASC
$$;

GRANT EXECUTE ON FUNCTION public.repricer_asin_raises(uuid, timestamptz, text[], int) TO service_role;
