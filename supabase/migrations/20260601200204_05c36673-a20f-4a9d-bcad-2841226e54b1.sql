UPDATE public.sales_orders
SET needs_price_enrich = true,
    next_enrich_after = NULL,
    last_enrich_error = NULL,
    updated_at = now()
WHERE asin = 'B0BMTMQTW5'
  AND order_id = '112-1623440-3264228'
  AND (sold_price IS NULL OR sold_price = 0)
  AND (total_sale_amount IS NULL OR total_sale_amount = 0);