UPDATE public.sales_orders
SET sold_price = 0,
    item_price = 0,
    total_sale_amount = 0,
    needs_price_enrich = true,
    price_last_error = 'SUSPICIOUS_HALF_PRICE_HOLD',
    price_last_attempt_at = now(),
    updated_at = now()
WHERE order_id = '114-2126311-8961814'
  AND asin = 'B0GGMLFGPG'
  AND sold_price > 0
  AND sold_price < (COALESCE(estimated_price, 0) * 0.6);