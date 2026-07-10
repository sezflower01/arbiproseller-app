-- Force clear the bad cache (previous DELETE somehow didn't apply)
DELETE FROM public.asin_fee_cache
WHERE asin = 'B004AGM25Q';

-- Force ROI to 0 on all fees_invalid rows (previous update missed some)
UPDATE public.sales_orders
SET roi = 0
WHERE fees_invalid = true
  AND roi <> 0;