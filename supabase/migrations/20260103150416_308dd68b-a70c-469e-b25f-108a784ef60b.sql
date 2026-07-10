-- Reset sold_price for pending orders synced before the ItemPrice + ShippingPrice fix
-- This forces them to be re-enriched with the correct total (ItemPrice + ShippingPrice)
-- Only affects pending/Pending status orders where sold_price > 0 (already had partial data)
UPDATE public.sales_orders
SET sold_price = 0,
    total_sale_amount = 0,
    updated_at = now()
WHERE status IN ('pending', 'Pending')
  AND sold_price > 0
  AND order_status = 'Pending';