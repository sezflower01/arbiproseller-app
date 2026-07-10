
-- Seed asin_sales_daily with last 30 days of data
INSERT INTO public.asin_sales_daily (user_id, marketplace, date, asin, sku, units, revenue, last_updated_at)
SELECT 
  s.user_id,
  COALESCE(s.marketplace, 'US'),
  s.order_date,
  s.asin,
  max(s.seller_sku),
  SUM(COALESCE(s.quantity, 1))::integer,
  SUM(COALESCE(s.total_sale_amount, 0)),
  now()
FROM public.sales_orders s
WHERE s.asin IS NOT NULL 
  AND s.asin NOT IN ('PENDING', 'UNKNOWN', '')
  AND s.order_date >= CURRENT_DATE - 30
  AND NOT s.order_id LIKE '%-REFUND'
  AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
GROUP BY s.user_id, COALESCE(s.marketplace, 'US'), s.order_date, s.asin
ON CONFLICT (user_id, marketplace, date, asin) 
DO UPDATE SET units = EXCLUDED.units, revenue = EXCLUDED.revenue, sku = EXCLUDED.sku, last_updated_at = now();
