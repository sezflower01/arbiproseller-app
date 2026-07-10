-- Delete ghost sales_orders rows where:
--   • asin is NOT a real Amazon ASIN (10-char alphanumeric) or is PENDING/UNKNOWN
--   • unit_cost is missing or zero
--   • a healthy sibling row exists for the same (user_id, order_id) with
--     a valid ASIN AND a positive unit_cost
-- Healthy siblings remain untouched.
DELETE FROM public.sales_orders g
WHERE (g.asin IS NULL
       OR g.asin IN ('PENDING','UNKNOWN')
       OR g.asin !~ '^[A-Z0-9]{10}$')
  AND (g.unit_cost IS NULL OR g.unit_cost = 0)
  AND EXISTS (
    SELECT 1
    FROM public.sales_orders s
    WHERE s.user_id = g.user_id
      AND s.order_id = g.order_id
      AND s.id <> g.id
      AND s.asin ~ '^[A-Z0-9]{10}$'
      AND s.asin NOT IN ('PENDING','UNKNOWN')
      AND s.unit_cost IS NOT NULL
      AND s.unit_cost > 0
  );