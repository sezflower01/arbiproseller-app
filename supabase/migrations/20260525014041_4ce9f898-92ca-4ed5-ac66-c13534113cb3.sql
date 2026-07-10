-- Repair sales_orders.unit_cost / total_cost for rows whose inventory row has a manual cost set,
-- but were stamped with the (incorrect) created_listings bundle math instead.
UPDATE public.sales_orders so
SET unit_cost = inv.cost,
    total_cost = ROUND((inv.cost * COALESCE(so.quantity, 1))::numeric, 2)
FROM public.inventory inv
WHERE so.user_id = inv.user_id
  AND so.asin = inv.asin
  AND inv.unit_cost_manual = true
  AND inv.cost IS NOT NULL
  AND inv.cost > 0
  AND (so.unit_cost IS NULL OR ABS(so.unit_cost - inv.cost) > 0.01);