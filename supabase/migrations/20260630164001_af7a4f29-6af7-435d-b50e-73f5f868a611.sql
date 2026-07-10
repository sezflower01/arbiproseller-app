UPDATE public.sales_orders
SET estimated_price = 26.50,
    price_source = 'estimated:repricer_price_actions',
    price_calc_mode = 'estimated_fee_warmup',
    updated_at = now()
WHERE order_id = '114-2245835-6127451'
  AND user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND sold_price = 0
  AND order_status = 'Pending';

-- Invalidate Live Sales period cache so today's totals recompute.
DELETE FROM public.live_sales_period_cache
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9';