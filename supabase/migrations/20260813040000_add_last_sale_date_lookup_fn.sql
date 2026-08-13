-- Debug/reporting helper: correctly aggregated MAX(order_date) per
-- (asin, marketplace) for a user's sales_orders, avoiding the PostgREST
-- 1000-row-per-request cap that silently truncates a naive client-side
-- "order by date desc, take first per key" approach once total matching
-- rows exceed 1000.
CREATE OR REPLACE FUNCTION public.debug_last_sale_dates(p_user_id uuid, p_asins text[])
RETURNS TABLE(asin text, marketplace text, last_order_date date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT so.asin, so.marketplace, MAX(so.order_date) AS last_order_date
  FROM public.sales_orders so
  WHERE so.user_id = p_user_id
    AND so.asin = ANY(p_asins)
  GROUP BY so.asin, so.marketplace;
$$;

REVOKE ALL ON FUNCTION public.debug_last_sale_dates(uuid, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.debug_last_sale_dates(uuid, text[]) TO service_role;
