UPDATE public.sales_orders
SET sold_price = 22.38,
    item_price = 22.38,
    total_sale_amount = 156.66,
    needs_fee_enrich = true,
    needs_price_enrich = false,
    price_source = 'orders_itemprice',
    price_confidence = 'CONFIRMED',
    price_enrich_status = 'enriched',
    price_last_error = 'REPAIRED_ORDERS_API_PER_UNIT',
    updated_at = now()
WHERE order_id = '114-2517244-0299440'
  AND asin = 'B01D0BD8CM'
  AND sold_price = 3.20;