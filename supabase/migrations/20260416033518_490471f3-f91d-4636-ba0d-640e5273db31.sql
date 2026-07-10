
-- Backfill marketplace from sales_orders for FEC rows with missing marketplace
UPDATE public.financial_events_cache f
SET 
  marketplace = so.marketplace,
  marketplace_id = CASE so.marketplace
    WHEN 'US' THEN 'ATVPDKIKX0DER'
    WHEN 'CA' THEN 'A2EUQ1WTGCTBG2'
    WHEN 'MX' THEN 'A1AM78C64UM0Y8'
    WHEN 'BR' THEN 'A2Q3Y263D00KWC'
    ELSE NULL
  END
FROM public.sales_orders so
WHERE f.amazon_order_id = so.order_id
  AND f.user_id = so.user_id
  AND (f.marketplace IS NULL OR f.marketplace = '' OR f.marketplace = 'UNKNOWN')
  AND so.marketplace IS NOT NULL
  AND so.marketplace != ''
  AND so.marketplace != 'UNKNOWN';

-- Also handle refund order IDs (format: xxx-REFUND)
UPDATE public.financial_events_cache f
SET 
  marketplace = so.marketplace,
  marketplace_id = CASE so.marketplace
    WHEN 'US' THEN 'ATVPDKIKX0DER'
    WHEN 'CA' THEN 'A2EUQ1WTGCTBG2'
    WHEN 'MX' THEN 'A1AM78C64UM0Y8'
    WHEN 'BR' THEN 'A2Q3Y263D00KWC'
    ELSE NULL
  END
FROM public.sales_orders so
WHERE f.amazon_order_id LIKE '%-REFUND'
  AND REPLACE(f.amazon_order_id, '-REFUND', '') = so.order_id
  AND f.user_id = so.user_id
  AND (f.marketplace IS NULL OR f.marketplace = '' OR f.marketplace = 'UNKNOWN')
  AND so.marketplace IS NOT NULL
  AND so.marketplace != ''
  AND so.marketplace != 'UNKNOWN';
