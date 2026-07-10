UPDATE public.sales_orders so
SET
  estimated_price = ROUND((so.estimated_price * fx.rate)::numeric, 2),
  updated_at      = now()
FROM public.fx_rates fx
WHERE so.marketplace IS NOT NULL
  AND so.marketplace <> 'US'
  AND so.estimated_price IS NOT NULL
  AND so.estimated_price > 0
  AND (
        so.price_source LIKE 'listings_api_%'
     OR so.price_source LIKE 'pricing_api_%'
     OR so.price_source LIKE 'seller_derived:%'
     OR so.price_source LIKE 'hint:%'
  )
  AND fx.base = 'USD'
  AND fx.quote = CASE so.marketplace
        WHEN 'CA' THEN 'CAD'
        WHEN 'MX' THEN 'MXN'
        WHEN 'BR' THEN 'BRL'
        WHEN 'UK' THEN 'GBP'
        WHEN 'DE' THEN 'EUR'
        WHEN 'ES' THEN 'EUR'
        WHEN 'FR' THEN 'EUR'
        WHEN 'IT' THEN 'EUR'
      END;