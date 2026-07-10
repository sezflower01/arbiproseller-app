-- Repair corrupted unit_cost on sales_orders where it diverges from the
-- manual inventory cost for the same (user_id, sku). Manual cost is Contract A
-- truth and must never be a fractional artifact like 2.29 / 26 = 0.088.
WITH bad_rows AS (
  SELECT so.id, i.cost AS true_unit_cost, so.quantity, so.total_fees,
         (so.sold_price * so.quantity) AS total_sale
  FROM sales_orders so
  JOIN inventory i
    ON i.user_id = so.user_id
   AND i.sku = so.sku
   AND i.unit_cost_manual = true
   AND i.cost > 0
  WHERE so.unit_cost IS NOT NULL
    AND ABS(so.unit_cost - i.cost) > 0.01
)
UPDATE sales_orders so
SET unit_cost = b.true_unit_cost,
    total_cost = b.true_unit_cost * b.quantity,
    roi = CASE
            WHEN COALESCE(so.fees_invalid, false) = true THEN NULL
            WHEN b.true_unit_cost * b.quantity > 0 THEN
              ROUND(
                ((b.total_sale - COALESCE(so.total_fees,0) - (b.true_unit_cost * b.quantity))
                  / (b.true_unit_cost * b.quantity) * 100)::numeric,
                1
              )
            ELSE so.roi
          END,
    updated_at = now()
FROM bad_rows b
WHERE so.id = b.id;