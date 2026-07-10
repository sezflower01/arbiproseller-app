-- Targeted backfill: strip shipping from total_sale_amount on unsettled Orders-API rows
UPDATE public.sales_orders
SET
  total_sale_amount = ROUND((item_price * quantity)::numeric, 2),
  updated_at = now()
WHERE settlement_date IS NULL
  AND price_source = 'orders_itemprice'
  AND shipping_price IS NOT NULL
  AND shipping_price > 0
  AND item_price IS NOT NULL
  AND total_sale_amount IS NOT NULL
  AND quantity IS NOT NULL
  AND quantity > 0
  AND ABS(total_sale_amount - (item_price + shipping_price) * quantity) < 0.05;