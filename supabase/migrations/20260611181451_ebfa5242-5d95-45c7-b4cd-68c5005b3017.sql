
-- 1) Wipe the corrupted MX cache row (63 MXN stored as $63 USD by sp_api_live writer)
DELETE FROM public.asin_fee_cache
WHERE id = '3f7dbb24-3765-4e2c-badd-49405724cbd9';

-- 2) Reset the bad US order so the next sync re-applies fees from the correct US cache
UPDATE public.sales_orders
SET fba_fee = NULL,
    referral_fee = NULL,
    closing_fee = NULL,
    total_fees = NULL,
    fees_missing = true,
    fees_source = 'unavailable',
    needs_fee_enrich = true,
    next_enrich_after = now(),
    updated_at = now()
WHERE order_id = '112-3554833-0176241'
  AND asin = 'B001FD3756';
