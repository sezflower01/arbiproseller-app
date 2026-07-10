
-- Scoped repair: ASIN B07RQ9QB6K only. Authoritative unit cost from created_listings: $7.27.

UPDATE public.inventory
SET cost   = 7.27,
    amount = ROUND((7.27 * COALESCE(units, 0))::numeric, 2),
    updated_at = now()
WHERE asin = 'B07RQ9QB6K'
  AND (cost IS NULL OR cost < 5);

UPDATE public.sales_orders
SET unit_cost  = 7.27,
    total_cost = ROUND((7.27 * COALESCE(quantity, 1))::numeric, 2),
    roi = CASE
            WHEN sold_price > 0 AND quantity > 0 THEN
              ROUND((((sold_price - (7.27 * quantity) - COALESCE(total_fees,0))
                       / NULLIF(7.27 * quantity, 0)) * 100)::numeric, 2)
            ELSE roi
          END,
    updated_at = now()
WHERE asin = 'B07RQ9QB6K'
  AND unit_cost < 5;
